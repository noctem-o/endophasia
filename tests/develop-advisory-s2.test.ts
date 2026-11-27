// S2 acceptance and adversarial suite (COORDINATOR-AUTOMATION-S2, docs/designs/coordinator-automation-s2-implementation.md).
// Covers S0-AT09, S0-AT10 and the S2 matrix items 1-23 named in each test title. Every test drives the real advisory tick, the real
// stores and the real lock-free status/coordination projections over a real project; only the model runner and the member observer
// are fakes, and both count every call so "zero inference" is an observed fact rather than a return value.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pinnedCoordinatorBriefStatusV0 } from "../adapters/coordinator/openclaw.ts";
import {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	decideEndoAdvisoryProposalV0,
	readEndoAdvisoryProjectionV0,
	removeEndoAdvisoryScheduleV0,
	revokeEndoAdvisoryAuthorizationV0,
	setEndoAdvisoryScheduleEnabledV0,
} from "../adapters/develop/advisory-operator.ts";
import {
	defaultObserveAdvisoryProjectV0,
	type RunEndoAdvisoryTickOptionsV0,
	runEndoAdvisoryTickV0,
} from "../adapters/develop/advisory-tick.ts";
import { runEndoSchedulerTickV0 } from "../adapters/develop/scheduler-tick.ts";
import {
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
	type EndoCoordinatorModelPoolMemberV0,
	type EndoCoordinatorModelPoolV0,
	parseEndoCoordinatorModelPoolV0,
} from "../protocol/coordinator-model-pool.ts";
import type {
	EndoAdvisoryActionKindV0,
	EndoAdvisoryBudgetV0,
	EndoAdvisoryPolicyV0,
	EndoAdvisoryWakePolicyV0,
} from "../protocol/develop-advisory.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import type {
	EndoCoordinatorMemberObservationV0,
	EndoCoordinatorMemberReadinessV0,
} from "../runtime/contracts/coordinator-model-pool.ts";
import {
	endoAdvisoryAuthorizationStandingV0,
	endoAdvisoryBudgetStandingV0,
	endoAdvisoryEffectivePoolV0,
	endoAdvisoryParseProposalLineV0,
	endoAdvisorySemanticObservationV0,
} from "../runtime/contracts/develop-advisory.ts";
import { readEndoCoordinatorCoordinationV0 } from "../storage/coordinator-coordination.ts";
import { readEndoCoordinatorStatusV0 } from "../storage/coordinator-status.ts";
import { DevelopAdvisoryStoreV0 } from "../storage/develop-advisory.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopAutomationStoreV0 } from "../storage/develop-automation.ts";
import { DevelopCoordinationStoreV0 } from "../storage/develop-coordination.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { acquireEndoEventStoreWriterLockV0 } from "../storage/writer-lock.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const WORKER = join(REPO_ROOT, "tests", "fixtures", "s2-advisory-worker.ts");
const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = Date.parse("2026-11-26T00:00:00.000Z");
const temps: string[] = [];
afterEach(() => {
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	temps.push(d);
	return d;
};

function ok<T>(r: { ok: true; value: T } | { ok: false; code?: string; detail?: string }): T {
	if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
	return r.value;
}

// ---- Fixtures --------------------------------------------------------------------------------------------------------------------

function project(root: string, name = "s2-proj") {
	const repo = tmp(`endo-s2-repo-${name}-`);
	const tasks = new DevelopTasksStoreV0(root);
	const p = ok(tasks.registerProject({ name, path: repo, observedGitRoot: null }));
	const t = ok(tasks.createTask(p.id, { title: "Advisory subject" }));
	return { projectId: p.id, taskId: t.id, repo, tasks };
}

function setStatus(root: string, projectId: string, taskId: string, ...path: string[]) {
	const tasks = new DevelopTasksStoreV0(root);
	for (const to of path) {
		const read = tasks.read();
		if (!read.ok || !read.exists) throw new Error("tasks unreadable");
		const task = read.file.tasks.find((t) => t.id === taskId)!;
		ok(tasks.setStatus(projectId, taskId, task.revision, to, null));
	}
}

function pool(memberIds: string[] = ["local-a"], maxOutputTokens = 512): EndoCoordinatorModelPoolV0 {
	return parseEndoCoordinatorModelPoolV0({
		schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
		selection: { fallback: "availability", unconfirmedModel: "permit" },
		members: memberIds.map((memberId, i) => ({
			memberId,
			kind: "local-openai-compat",
			endpoint: `http://127.0.0.1:${18091 + i}`,
			modelId: `model-${memberId}`,
			priority: 100 - i,
			maxPromptBytes: 8192,
			maxOutputTokens,
			timeoutMs: 30_000,
			advisoryOnly: true,
		})),
	});
}

const BUDGET: EndoAdvisoryBudgetV0 = {
	periodMs: 24 * HOUR,
	maxTurnsPerPeriod: 8,
	completionRequestsPerTurn: 2,
	maxOutputTokensPerRequest: 512,
	maxGeneratedTokensPerPeriod: 8 * 1024,
	maxTurnWallClockMs: 60_000,
};
const POLICY: EndoAdvisoryPolicyV0 = {
	permitCapacityUnknown: false,
	permitModelUnconfirmed: false,
	permitPartialObservation: true,
	observationSource: "recorded-or-passive-probe",
	recordedObservationMaxAgeMs: 10 * MIN,
};

class Clock {
	t = BASE;
	now = () => this.t;
	at(ms: number) {
		this.t = ms;
	}
}

function configure(
	root: string,
	clock: Clock,
	args: {
		projectId: string;
		scheduleId?: string;
		action?: EndoAdvisoryActionKindV0;
		wake?: EndoAdvisoryWakePolicyV0;
		budget?: Partial<EndoAdvisoryBudgetV0>;
		policy?: Partial<EndoAdvisoryPolicyV0>;
		pool?: EndoCoordinatorModelPoolV0;
		authorize?: boolean;
	},
) {
	const scheduleId = args.scheduleId ?? "adv-1";
	ok(
		addEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId,
				label: null,
				projectId: args.projectId,
				actionKind: args.action ?? "generate-advisory-brief",
				wake: args.wake ?? "on-change",
				missedRunPolicy: "skip-and-report",
				trigger: { kind: "interval", everyMs: 15 * MIN, anchorMs: BASE },
			},
			clock.now,
		),
	);
	const enabled = ok(setEndoAdvisoryScheduleEnabledV0(root, scheduleId, true, 1, clock.now));
	if (args.authorize === false) return { scheduleId, revision: enabled.schedule.revision };
	const grant = ok(
		authorizeEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId,
				scheduleRevision: enabled.schedule.revision,
				pool: args.pool ?? pool(),
				policy: { ...POLICY, ...args.policy },
				budget: { ...BUDGET, ...args.budget },
				lifetimeMs: 7 * 24 * HOUR,
			},
			clock.now,
		),
	);
	return { scheduleId, revision: enabled.schedule.revision, grant };
}

function observer(
	readiness:
		| EndoCoordinatorMemberReadinessV0
		| ((m: EndoCoordinatorModelPoolMemberV0) => EndoCoordinatorMemberReadinessV0),
	clock: Clock,
) {
	const calls: string[] = [];
	const observe = async (member: EndoCoordinatorModelPoolMemberV0): Promise<EndoCoordinatorMemberObservationV0> => {
		calls.push(member.memberId);
		const r = typeof readiness === "function" ? readiness(member) : readiness;
		return {
			memberId: member.memberId,
			endpoint: member.endpoint,
			modelId: member.modelId,
			basis: "controller-observed",
			observedAtMs: clock.t,
			elapsedMs: 1,
			readiness: r,
			detail: r === "ready" ? "slot-idle" : r === "unreachable" ? "connect-failed" : "slots-not-observable",
			backend: "llama.cpp-single",
			build: null,
			requests: [{ path: "/health", status: r === "unreachable" ? null : 200 }],
			inferenceTokens: 0,
		};
	};
	return { observe, calls };
}

interface FakeRunOptions {
	answer?: (projectId: string) => string;
	usage?: "complete" | "missing";
	during?: () => void | Promise<void>;
	unavailable?: string;
}

/** The fake reports the projection it was pinned to, as the real runner does; unpinned it reports an unrelated digest. */
const pinnedSha = (options: Record<string, any>) =>
	options.pinnedObservation === undefined
		? "b".repeat(64)
		: sha256HexV0(canonicalEndoJsonV0(options.pinnedObservation.status));

function fakeRun(opts: FakeRunOptions = {}) {
	const calls: {
		projectId: string;
		question: string | undefined;
		endpoint: string;
		model: string;
		timeoutMs: number;
	}[] = [];
	const run = async (
		_root: string,
		request: { projectId: string; question?: string },
		options: Record<string, any>,
	) => {
		calls.push({
			projectId: request.projectId,
			question: request.question,
			endpoint: options.target.origin,
			model: options.target.model,
			timeoutMs: options.target.timeoutMs,
		});
		await opts.during?.();
		const usage = opts.usage ?? "complete";
		options.trial?.({
			promptSha256: "a".repeat(64),
			inference: {},
			wire: {
				responses:
					usage === "complete"
						? [
								{
									finish: "tool_calls",
									usage: { prompt_tokens: 400, completion_tokens: 40 },
									text: "",
									toolCalled: true,
								},
								{
									finish: "stop",
									usage: { prompt_tokens: 900, completion_tokens: 160 },
									text: "x",
									toolCalled: false,
								},
							]
						: [
								{ finish: "tool_calls", usage: null, text: "", toolCalled: true },
								{ finish: "stop", usage: null, text: "x", toolCalled: false },
							],
			},
			dispatched: true,
			toolOutcome: null,
			evidence: { readAtMs: 1, projectionSha256: pinnedSha(options), modelViewSha256: "c".repeat(64) },
			latencyMs: 5,
			inferenceElapsedMs: 5,
			admittedExchanges: 2,
			recorderClean: true,
			stderr: "",
		});
		const runtime = { harness: "OpenClaw 2026.11.7", provider: "fake", model: options.target.model };
		if (opts.unavailable !== undefined)
			return {
				schemaVersion: "endo.coordinator-brief.v0",
				projectId: request.projectId,
				runtime,
				availability: "unavailable",
				reason: opts.unavailable,
			};
		return {
			schemaVersion: "endo.coordinator-brief.v0",
			projectId: request.projectId,
			runtime,
			availability: "available",
			answer: opts.answer?.(request.projectId) ?? "- Nothing needs attention.\n- Verification is not established.",
			evidence: { readAtMs: 1, projectionSha256: pinnedSha(options), modelViewSha256: "c".repeat(64) },
			toolSurface: ["endophasia_status"],
		};
	};
	return { run: run as unknown as NonNullable<RunEndoAdvisoryTickOptionsV0["run"]>, calls };
}

const tick = (
	root: string,
	clock: Clock,
	run: ReturnType<typeof fakeRun>,
	obs: ReturnType<typeof observer>,
	extra: Partial<RunEndoAdvisoryTickOptionsV0> = {},
) =>
	runEndoAdvisoryTickV0({
		root,
		now: clock.now,
		run: run.run,
		observeMember: obs.observe,
		onTimeGraceMs: 10 * MIN,
		...extra,
	});

const windowAt = (k: number) => BASE + k * 15 * MIN + 1_000;
const listTurns = (root: string) => {
	const t = new DevelopAdvisoryStoreV0(root).listTurns();
	if (!t.ok) throw new Error("turns unreadable");
	return t.entries;
};
const listProposals = (root: string) => {
	const t = new DevelopAdvisoryStoreV0(root).listProposals();
	if (!t.ok) throw new Error("proposals unreadable");
	return t.entries;
};
const statusOf = (r: Awaited<ReturnType<typeof runEndoAdvisoryTickV0>>) => {
	if (!r.ok) throw new Error(`tick refused: ${r.refusal} ${r.detail}`);
	return r.outcomes.filter((o) => o.status !== "missed-skipped").map((o) => o.status);
};

/** Every file under the store except the advisory directory, with its bytes: the governance sentinel. */
function snapshotOutsideAdvisory(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string) => {
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, name.name);
			if (p === join(root, "develop", "automation", "advisory")) continue;
			if (name.isDirectory()) walk(p);
			else if (name.isFile() && !name.name.startsWith("automation.lock")) out.set(p, readFileSync(p, "utf8"));
		}
	};
	walk(root);
	return out;
}

// ---- Tests -----------------------------------------------------------------------------------------------------------------------

describe("COORDINATOR-AUTOMATION-S2 advisory scheduling", () => {
	it("R01: a replacement incarnation cannot inherit an old live authorization", () => {
		const root = tmp("endo-s2-r01-");
		const clock = new Clock();
		const { projectId } = project(root);
		const { grant } = configure(root, clock, { projectId });
		const store = new DevelopAdvisoryStoreV0(root);
		const oldAuth = store.readAuthorizations();
		if (!oldAuth.ok || !oldAuth.exists) throw new Error("missing authorization");
		ok(removeEndoAdvisoryScheduleV0(root, "adv-1", 2, clock.now));
		configure(root, clock, { projectId, authorize: false });
		const replacement = readEndoAdvisoryProjectionV0(root, { now: clock.now }).schedules[0]!.schedule;
		expect(replacement.revision).toBe(grant!.scheduleRevision);
		expect(replacement.incarnation).not.toBe(grant!.scheduleIncarnation);
		expect(
			endoAdvisoryAuthorizationStandingV0({ schedule: replacement, file: oldAuth.value, nowMs: clock.t }),
		).toEqual({ ok: false, refusal: "schedule-revision-mismatch" });
	});

	it("R03: removing a consumed schedule refuses rather than evicting a replay floor", () => {
		const root = tmp("endo-s2-r03-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId });
		const store = new DevelopAdvisoryStoreV0(root);
		const read = store.readSchedules();
		if (!read.ok || !read.exists) throw new Error("missing schedules");
		expect(
			store.withAdvisoryLockSync((s) =>
				s.writeSchedules({
					...read.value,
					schedules: read.value.schedules.map((schedule) => ({
						...schedule,
						cursor: { ...schedule.cursor, lastConsumedWindowStartMs: BASE },
					})),
					retiredCursors: Array.from({ length: 256 }, (_, i) => ({
						scheduleId: `retired-${i}`,
						lastConsumedWindowStartMs: BASE,
						retiredAtMs: BASE,
					})),
				}),
			),
		).toMatchObject({ ok: true });
		expect(removeEndoAdvisoryScheduleV0(root, "adv-1", 2, clock.now)).toMatchObject({ ok: false, code: "too-many" });
		const after = store.readSchedules();
		if (!after.ok || !after.exists) throw new Error("missing schedules after refusal");
		expect(after.value.retiredCursors).toHaveLength(256);
		expect(after.value.retiredCursors[0]!.scheduleId).toBe("retired-0");
		expect(after.value.schedules).toHaveLength(1);
	});

	it("R06: fallback none cannot skip the first member when its output cap exceeds the grant", () => {
		const root = tmp("endo-s2-r06-");
		const clock = new Clock();
		const { projectId } = project(root);
		const original = pool(["primary", "secondary"]);
		const configured = parseEndoCoordinatorModelPoolV0({
			...original,
			selection: { ...original.selection, fallback: "none" },
			members: original.members.map((m, i) => ({ ...m, maxOutputTokens: i === 0 ? 1024 : 512 })),
		});
		const { grant } = configure(root, clock, { projectId, pool: configured });
		expect(endoAdvisoryEffectivePoolV0(grant!)).toBeNull();
	});

	it("R08: the real runner's pinned prompt evidence hashes to exactly the observation the tick gated on", async () => {
		const root = tmp("endo-s2-r08-");
		const { projectId } = project(root);
		const read = await defaultObserveAdvisoryProjectV0({ root, projectId, nowMs: BASE });
		const pinned = pinnedCoordinatorBriefStatusV0(root, projectId, structuredClone(read));
		if (!pinned.ok) throw new Error(`pinned status refused: ${pinned.reason}`);
		expect(pinned.evidence.projectionSha256).toBe(sha256HexV0(canonicalEndoJsonV0(read.status as never)));
		const other = project(root, "s2-other");
		const foreign = await defaultObserveAdvisoryProjectV0({ root, projectId: other.projectId, nowMs: BASE });
		expect(pinnedCoordinatorBriefStatusV0(root, projectId, foreign)).toMatchObject({ ok: false });
	});

	it("R07: missing attempt evidence makes an observation partial", async () => {
		const root = tmp("endo-s2-r07-");
		const { projectId } = project(root);
		const status = await readEndoCoordinatorStatusV0({ root, projects: [projectId], now: () => BASE });
		const coordination = await readEndoCoordinatorCoordinationV0({
			root,
			projects: [projectId],
			now: () => BASE,
			routes: "read",
		});
		const observation = endoAdvisorySemanticObservationV0(
			projectId,
			{ ...status, sources: { ...status.sources, attempts: { ...status.sources.attempts, state: "missing" } } },
			coordination,
		);
		expect(observation.completeness).toBe("partial");
		expect(observation.gaps).toContain("status-attempts-missing");
	});
	it("S2-2: a new advisory schedule is disabled and unauthorized; neither makes an inference request", async () => {
		const root = tmp("endo-s2-2-");
		const clock = new Clock();
		const { projectId } = project(root);
		ok(
			addEndoAdvisoryScheduleV0(
				root,
				{
					scheduleId: "adv-1",
					label: null,
					projectId,
					actionKind: "generate-advisory-brief",
					wake: "on-change",
					missedRunPolicy: "skip-and-report",
					trigger: { kind: "interval", everyMs: 15 * MIN, anchorMs: BASE },
				},
				clock.now,
			),
		);
		const run = fakeRun();
		const obs = observer("ready", clock);
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, run, obs))).toEqual([]);
		ok(setEndoAdvisoryScheduleEnabledV0(root, "adv-1", true, 1, clock.now));
		clock.at(windowAt(1));
		expect(statusOf(await tick(root, clock, run, obs))).toEqual(["refused-unauthorized"]);
		expect(run.calls).toHaveLength(0);
		expect(obs.calls).toHaveLength(0);
		expect(listTurns(root)).toHaveLength(0);
	});

	it("S2-2: an authorization binds one revision; disabling and re-enabling never inherits it", async () => {
		const root = tmp("endo-s2-2b-");
		const clock = new Clock();
		const { projectId } = project(root);
		const { scheduleId, revision } = configure(root, clock, { projectId });
		ok(setEndoAdvisoryScheduleEnabledV0(root, scheduleId, false, revision, clock.now));
		ok(setEndoAdvisoryScheduleEnabledV0(root, scheduleId, true, revision + 1, clock.now));
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now });
		expect(view.schedules[0]!.authorization).toEqual({ ok: false, refusal: "authorization-revoked" });
		const run = fakeRun();
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual(["refused-unauthorized"]);
		expect(run.calls).toHaveLength(0);
		// A grant for a stale revision is refused at grant time.
		const stale = authorizeEndoAdvisoryScheduleV0(
			root,
			{ scheduleId, scheduleRevision: revision, pool: pool(), policy: POLICY, budget: BUDGET, lifetimeMs: HOUR },
			clock.now,
		);
		expect(stale).toMatchObject({ ok: false, code: "stale-revision" });
	});

	it("S2-5, S0-AT09, S2-3, S2-4: first and changed states reason once each; unchanged and volatile-only states make zero requests", async () => {
		const root = tmp("endo-s2-5-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		configure(root, clock, { projectId });
		const run = fakeRun();
		const obs = observer("ready", clock);
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, run, obs))).toEqual(["briefing-published"]);
		expect(run.calls).toHaveLength(1);
		const [first] = listTurns(root);
		expect(first!.briefing).toMatchObject({
			availability: "available",
			wakeReason: "first-observation",
			standing: "untrusted-model-interpretation",
		});
		expect(first!.briefing!.source.currency).toBe("current-at-publication");

		// Volatile only: hours pass (every read time, freshness age and staleness clock moves) and an unrelated event lands.
		for (const k of [1, 2, 3, 8]) {
			clock.at(windowAt(k));
			expect(statusOf(await tick(root, clock, run, obs))).toEqual(["skipped-unchanged"]);
		}
		expect(run.calls).toHaveLength(1);
		expect(obs.calls).toHaveLength(1);
		const fires = readEndoAdvisoryProjectionV0(root, { now: clock.now }).fires;
		expect(fires.find((f) => f.status === "skipped-unchanged")).toMatchObject({
			inferenceDispatched: "no",
			turnId: null,
		});

		setStatus(root, projectId, taskId, "in-progress", "blocked");
		clock.at(windowAt(9));
		expect(statusOf(await tick(root, clock, run, obs))).toEqual(["briefing-published"]);
		expect(run.calls).toHaveLength(2);
		expect(listTurns(root)[0]!.briefing!.wakeReason).toBe("state-changed");
	});

	it("S2-4: the semantic digest ignores read times, ages and time-driven staleness but tracks task state", async () => {
		const root = tmp("endo-s2-4-");
		const { projectId, taskId } = project(root);
		const read = async (nowMs: number) => {
			const status = await readEndoCoordinatorStatusV0({ root, projects: [projectId], now: () => nowMs });
			const coordination = await readEndoCoordinatorCoordinationV0({
				root,
				projects: [projectId],
				now: () => nowMs,
				routes: "read",
			});
			return endoAdvisorySemanticObservationV0(projectId, status, coordination);
		};
		const a = await read(BASE);
		const b = await read(BASE + 72 * HOUR);
		expect(a.semanticDigest).not.toBeNull();
		expect(b.semanticDigest).toBe(a.semanticDigest);
		setStatus(root, projectId, taskId, "in-progress");
		expect((await read(BASE + 72 * HOUR)).semanticDigest).not.toBe(a.semanticDigest);
	});

	it("S2-6: an explicit digest window reasons on unchanged state, still under the budget", async () => {
		const root = tmp("endo-s2-6-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId, wake: "digest-window", budget: { maxTurnsPerPeriod: 2 } });
		const run = fakeRun();
		const obs = observer("ready", clock);
		const statuses: string[] = [];
		for (const k of [0, 1, 2]) {
			clock.at(windowAt(k));
			statuses.push(...statusOf(await tick(root, clock, run, obs)));
		}
		expect(statuses).toEqual(["briefing-published", "briefing-published", "refused-budget"]);
		expect(run.calls).toHaveLength(2);
		expect(listTurns(root).map((t) => t.briefing?.wakeReason)).toEqual(["digest-window", "digest-window"]);
	});

	it("S2-7, S2-13: an unavailable model leaves the scheduler operational and the same state is never retried automatically", async () => {
		const root = tmp("endo-s2-7-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		configure(root, clock, { projectId });
		const run = fakeRun();
		const obs = observer("unreachable", clock);
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, run, obs))).toEqual(["refused-model-unavailable"]);
		const [turn] = listTurns(root);
		expect(turn!.dispatch).toBeNull();
		expect(turn!.briefing).toMatchObject({ availability: "not-dispatched", refusal: "no-eligible-member" });
		expect(turn!.briefing!.accounting).toMatchObject({ chargedCompletionRequests: 0, chargedGeneratedTokens: 0 });
		clock.at(windowAt(1));
		expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual(["skipped-already-attempted"]);
		// The scheduler keeps working: a real change is admitted once the model is back.
		setStatus(root, projectId, taskId, "in-progress");
		clock.at(windowAt(2));
		expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual(["briefing-published"]);
		expect(run.calls).toHaveLength(1);
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now });
		expect(view.schedules[0]!.schedule.cursor.lastConsideredSemanticDigest).toBe(
			listTurns(root)[0]!.admission.semanticDigest,
		);
	});

	it("S2-8: unknown capacity needs explicit policy; stale recorded observations are not used", async () => {
		const clock = new Clock();
		for (const [permit, expected] of [
			[false, "refused-uncertainty-policy"],
			[true, "briefing-published"],
		] as const) {
			const root = tmp("endo-s2-8-");
			const { projectId } = project(root);
			configure(root, clock, { projectId, policy: { permitCapacityUnknown: permit } });
			const run = fakeRun();
			clock.at(windowAt(0));
			expect(statusOf(await tick(root, clock, run, observer("capacity-unknown", clock)))).toEqual([expected]);
			expect(run.calls).toHaveLength(permit ? 1 : 0);
			if (permit)
				expect(listTurns(root)[0]!.dispatch).toMatchObject({
					capacityConfirmed: false,
					selectedReadiness: "capacity-unknown",
				});
		}
		// recorded-only with no S1 observation: no live probe, no inference.
		const root = tmp("endo-s2-8b-");
		const { projectId } = project(root);
		configure(root, clock, { projectId, policy: { observationSource: "recorded-only" } });
		const run = fakeRun();
		const obs = observer("ready", clock);
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, run, obs))).toEqual(["refused-model-unavailable"]);
		expect(obs.calls).toHaveLength(0);
		expect(run.calls).toHaveLength(0);
	});

	it("S2-9: fallback happens only before dispatch; the dispatched member is final even when it fails", async () => {
		const root = tmp("endo-s2-9-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId, pool: pool(["primary", "secondary"]) });
		const obs = observer((m) => (m.memberId === "primary" ? "unreachable" : "ready"), clock);
		const run = fakeRun({ unavailable: "inference-timeout" });
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, run, obs))).toEqual(["briefing-refused"]);
		expect(run.calls).toHaveLength(1);
		expect(run.calls[0]!.model).toBe("model-secondary");
		const [turn] = listTurns(root);
		expect(turn!.dispatch).toMatchObject({ selectedMemberId: "secondary", fallbackOccurred: true });
		expect(turn!.briefing!.model).toMatchObject({ inferenceFailover: "never", fallbackOccurred: true });
		expect(turn!.briefing!.model.skippedMembers).toEqual([{ memberId: "primary", reason: "unreachable" }]);
	});

	it("S2-10: budgets come from the durable ledger, survive restarts, and missing usage is charged at the reservation", async () => {
		const root = tmp("endo-s2-10-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		configure(root, clock, { projectId, budget: { maxTurnsPerPeriod: 8, maxGeneratedTokensPerPeriod: 2048 } });
		const obs = observer("ready", clock);
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, fakeRun({ usage: "missing" }), obs))).toEqual(["briefing-published"]);
		expect(listTurns(root)[0]!.briefing!.accounting).toMatchObject({
			usageReportComplete: false,
			reportedCompletionTokens: null,
			chargedGeneratedTokens: 1024,
			chargedCompletionRequests: 2,
		});
		setStatus(root, projectId, taskId, "in-progress");
		clock.at(windowAt(1));
		expect(statusOf(await tick(root, clock, fakeRun(), obs))).toEqual(["briefing-published"]);
		expect(listTurns(root)[0]!.briefing!.accounting).toMatchObject({
			usageReportComplete: true,
			chargedGeneratedTokens: 200,
		});
		// 1024 + 200 charged; a third turn would reserve 1024 more > 2048: refused, by a fresh process reading the same ledger.
		setStatus(root, projectId, taskId, "blocked");
		clock.at(windowAt(2));
		const run = fakeRun();
		expect(statusOf(await tick(root, clock, run, obs))).toEqual(["refused-budget"]);
		expect(run.calls).toHaveLength(0);
		const budget = readEndoAdvisoryProjectionV0(root, { now: clock.now }).schedules[0]!.budget!;
		expect(budget).toMatchObject({
			turnsCharged: 2,
			generatedTokensCharged: 1224,
			admissible: false,
			refusal: "generated-tokens-exhausted",
		});
		// After the period rolls, the allowance returns.
		clock.at(windowAt(2) + 25 * HOUR);
		expect(statusOf(await tick(root, clock, fakeRun(), obs))).toContain("briefing-published");
	});

	it("S2-12, S2-13: a crash after the dispatch record is charged in full, recovered as uncertain and never replayed", async () => {
		const root = tmp("endo-s2-12-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId, wake: "digest-window" });
		const run = fakeRun();
		const obs = observer("ready", clock);
		clock.at(windowAt(0));
		await expect(
			tick(root, clock, run, obs, {
				hooks: {
					afterDispatchRecord: () => {
						throw new Error("crash after dispatch record");
					},
				},
			}),
		).rejects.toThrow("crash after dispatch record");
		expect(run.calls).toHaveLength(0);
		// Lease still held: the next tick inside it is refused, not run.
		clock.at(windowAt(0) + 2 * MIN);
		expect(await tick(root, clock, run, obs)).toMatchObject({ ok: false, refusal: "lease-held" });
		// After expiry the claim is recovered as dispatched-uncertain; the window is consumed and nothing is replayed.
		clock.at(windowAt(0) + 6 * MIN);
		const recovered = await tick(root, clock, run, obs);
		expect(recovered).toMatchObject({ ok: true, inferenceDispatched: false });
		if (!recovered.ok) return;
		expect(recovered.recovered).toHaveLength(1);
		expect(recovered.outcomes[0]).toMatchObject({ status: "failed", inferenceDispatched: "yes" });
		expect(run.calls).toHaveLength(0);
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now });
		expect(view.turns[0]!.state).toBe("uncertain");
		expect(view.schedules[0]!.budget).toMatchObject({
			uncertainTurns: 1,
			turnsCharged: 1,
			generatedTokensCharged: 1024,
		});
	});

	it("S2-12: a crash before the dispatch record is proven not dispatched and charged nothing", async () => {
		const root = tmp("endo-s2-12b-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId });
		const obs = observer("ready", clock);
		clock.at(windowAt(0));
		await expect(
			tick(root, clock, fakeRun(), obs, {
				hooks: {
					beforeDispatchRecord: () => {
						throw new Error("crash before dispatch");
					},
				},
			}),
		).rejects.toThrow("crash before dispatch");
		clock.at(windowAt(0) + 6 * MIN);
		const r = await tick(root, clock, fakeRun(), obs);
		expect(r.ok && r.outcomes[0]).toMatchObject({ status: "failed", inferenceDispatched: "no" });
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now });
		expect(view.turns[0]!.state).toBe("never-dispatched");
		expect(view.schedules[0]!.budget).toMatchObject({ turnsCharged: 0, generatedTokensCharged: 0 });
		// The admitted digest is recorded as attempted, so the unchanged state does not re-wake.
		clock.at(windowAt(1));
		expect(statusOf(await tick(root, clock, fakeRun(), obs))).toEqual(["skipped-already-attempted"]);
	});

	it("S2-12: a crash after inference but before publication leaves an uncertain charged turn and no briefing", async () => {
		const root = tmp("endo-s2-12c-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId });
		const run = fakeRun();
		clock.at(windowAt(0));
		await expect(
			tick(root, clock, run, observer("ready", clock), {
				hooks: {
					beforePublish: () => {
						throw new Error("crash before publish");
					},
				},
			}),
		).rejects.toThrow();
		expect(run.calls).toHaveLength(1);
		const [turn] = listTurns(root);
		expect(turn!.dispatch).not.toBeNull();
		expect(turn!.briefing).toBeNull();
		expect(listProposals(root)).toHaveLength(0);
	});

	it("S2-15: revocation before the dispatch record prevents dispatch", async () => {
		const root = tmp("endo-s2-15-");
		const clock = new Clock();
		const { projectId } = project(root);
		const { scheduleId } = configure(root, clock, { projectId });
		const run = fakeRun();
		clock.at(windowAt(0));
		const r = await tick(root, clock, run, observer("ready", clock), {
			hooks: { beforeDispatchRecord: () => void ok(revokeEndoAdvisoryAuthorizationV0(root, scheduleId, clock.now)) },
		});
		expect(statusOf(r)).toEqual(["refused-unauthorized"]);
		expect(run.calls).toHaveLength(0);
		expect(listTurns(root)[0]!.briefing).toMatchObject({
			availability: "not-dispatched",
			refusal: "authorization-revoked",
		});
	});

	it("S2-15: revocation, disablement or lease loss during inference withholds the result and creates no proposal", async () => {
		for (const race of ["revoke", "disable", "lease-expired"] as const) {
			const root = tmp(`endo-s2-15b-${race}-`);
			const clock = new Clock();
			const { projectId, taskId } = project(root);
			setStatus(root, projectId, taskId, "in-progress", "blocked");
			const { scheduleId, revision } = configure(root, clock, { projectId, action: "emit-operator-proposal" });
			clock.at(windowAt(0));
			const run = fakeRun({
				answer: () => `- Blocked.\nPROPOSAL: resolve-blocked-task ${taskId}`,
				during: () => {
					if (race === "revoke") ok(revokeEndoAdvisoryAuthorizationV0(root, scheduleId, clock.now));
					if (race === "disable")
						ok(setEndoAdvisoryScheduleEnabledV0(root, scheduleId, false, revision, clock.now));
					if (race === "lease-expired") clock.at(windowAt(0) + 10 * MIN);
				},
			});
			expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual(["result-withheld"]);
			const b = listTurns(root)[0]!.briefing!;
			expect(b.availability).toBe("withheld");
			expect(b.answer).toBeNull();
			expect(b.refusal).toBe(
				race === "revoke"
					? "authorization-revoked-in-flight"
					: race === "disable"
						? "schedule-changed-in-flight"
						: "lease-lost-in-flight",
			);
			expect(b.accounting.chargedCompletionRequests).toBe(2);
			expect(listProposals(root)).toHaveLength(0);
			const cursor = readEndoAdvisoryProjectionV0(root, { now: clock.now }).schedules[0]!.schedule.cursor;
			expect(cursor.lastConsideredSemanticDigest).toBeNull();
		}
	});

	it("S2-14: a superseded holder cannot publish as current, and the newer holder's recovery stands", async () => {
		const root = tmp("endo-s2-14-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId, wake: "digest-window" });
		clock.at(windowAt(0));
		let second: Awaited<ReturnType<typeof runEndoAdvisoryTickV0>> | null = null;
		const run = fakeRun({
			during: async () => {
				clock.at(windowAt(0) + 6 * MIN);
				second = await tick(root, clock, fakeRun(), observer("ready", clock));
			},
		});
		expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual([]);
		expect(second).toMatchObject({ ok: true });
		const fires = readEndoAdvisoryProjectionV0(root, { now: clock.now }).fires;
		const firstFire = fires.find((f) => f.windowStartMs === BASE)!;
		expect(firstFire).toMatchObject({ status: "failed", inferenceDispatched: "yes" });
		const stale = listTurns(root).find((t) => t.admission.leaseEpoch === 1)!;
		expect(stale.briefing).toMatchObject({ availability: "withheld", refusal: "lease-lost-in-flight", answer: null });
	});

	it("S2-16: a state change during inference is published as stale, not as considered, with no proposal", async () => {
		const root = tmp("endo-s2-16-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		setStatus(root, projectId, taskId, "in-progress", "blocked");
		configure(root, clock, { projectId, action: "emit-operator-proposal" });
		clock.at(windowAt(0));
		const run = fakeRun({
			answer: () => `- Blocked.\nPROPOSAL: resolve-blocked-task ${taskId}`,
			during: () => setStatus(root, projectId, taskId, "in-progress"),
		});
		expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual(["briefing-published"]);
		const b = listTurns(root)[0]!.briefing!;
		expect(b.source.currency).toBe("stale-at-publication");
		expect(b.source.publicationSemanticDigest).not.toBe(b.source.admissionSemanticDigest);
		expect(b.proposal).toEqual({ outcome: "refused", proposalId: null, refusal: "proposal-state-stale" });
		expect(
			readEndoAdvisoryProjectionV0(root, { now: clock.now }).schedules[0]!.schedule.cursor
				.lastConsideredSemanticDigest,
		).toBeNull();
		// The new state is admitted on the next window (the attempted digest was the old one).
		clock.at(windowAt(1));
		expect(statusOf(await tick(root, clock, fakeRun(), observer("ready", clock)))).toEqual(["briefing-published"]);
	});

	it("S2-17: invalid, ungrounded, cross-project and injection-bearing outputs never become proposals", async () => {
		const cases: [string, (ids: { taskId: string; otherTaskId: string }) => string, string][] = [
			["no line", () => "- All fine.", "proposal-unparseable"],
			[
				"two lines",
				({ taskId }) => `PROPOSAL: none\nPROPOSAL: resolve-blocked-task ${taskId}`,
				"proposal-unparseable",
			],
			["not last", ({ taskId }) => `PROPOSAL: resolve-blocked-task ${taskId}\n- trailing`, "proposal-unparseable"],
			[
				"extra token",
				({ taskId }) => `PROPOSAL: resolve-blocked-task ${taskId} && rm -rf /`,
				"proposal-unparseable",
			],
			["unknown kind", ({ taskId }) => `PROPOSAL: merge-pull-request ${taskId}`, "proposal-kind-unknown"],
			["ungrounded", ({ taskId }) => `PROPOSAL: review-awaiting-review ${taskId}`, "proposal-ungrounded"],
			[
				"other project",
				({ otherTaskId }) => `PROPOSAL: resolve-blocked-task ${otherTaskId}`,
				"proposal-subject-unknown",
			],
		];
		for (const [name, answer, refusal] of cases) {
			const root = tmp("endo-s2-17-");
			const clock = new Clock();
			const { projectId, taskId } = project(root, "a");
			const other = project(root, "b");
			setStatus(root, projectId, taskId, "in-progress", "blocked");
			setStatus(root, other.projectId, other.taskId, "in-progress", "blocked");
			configure(root, clock, { projectId, action: "emit-operator-proposal" });
			clock.at(windowAt(0));
			const run = fakeRun({ answer: () => answer({ taskId, otherTaskId: other.taskId }) });
			expect(statusOf(await tick(root, clock, run, observer("ready", clock))), name).toEqual(["briefing-published"]);
			expect(listTurns(root)[0]!.briefing!.proposal, name).toEqual({
				outcome: "refused",
				proposalId: null,
				refusal,
			});
			expect(listProposals(root), name).toHaveLength(0);
		}
		expect(endoAdvisoryParseProposalLineV0("**PROPOSAL: none**")).toEqual({ state: "none" });
	});

	it("S0-AT10, S2-19: a proposal about an active assignment is untrusted, grants nothing and touches no governed state", async () => {
		const root = tmp("endo-s2-at10-");
		const clock = new Clock();
		const { projectId, taskId, repo } = project(root);
		const tasks = new DevelopTasksStoreV0(root);
		const read = tasks.read();
		if (!read.ok || !read.exists) throw new Error("tasks");
		const task = read.file.tasks.find((t) => t.id === taskId)!;
		const coord = new DevelopCoordinationStoreV0(root, { now: clock.now });
		const created = coord.createAssignment({
			expectedFileRevision: 0,
			expectedTaskRevision: task.revision,
			projectId,
			taskId,
			participant: { participantId: "builder-1", role: "builder", intendedHarnessFamily: "codex" },
			workspace: {
				worktreePath: repo,
				registration: "project-path",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: false,
			},
			targetCandidate: null,
		});
		expect(created.ok).toBe(true);
		configure(root, clock, { projectId, action: "emit-operator-proposal" });
		const before = snapshotOutsideAdvisory(root);
		clock.at(windowAt(0));
		const run = fakeRun({
			answer: () => `- Assignment active.\nPROPOSAL: consider-attempt-for-assignment ${taskId}`,
		});
		expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual(["briefing-published"]);
		const [entry] = listProposals(root);
		expect(entry!.proposal).toMatchObject({
			kind: "consider-attempt-for-assignment",
			standing: "untrusted-advisory-proposal",
			authority: { grants: "none", executionAuthority: false, requiresOperatorConfirmationPerAttempt: true },
		});
		expect(entry!.proposal.evidence.facts).toEqual([
			{ fact: "assignment-active", subject: entry!.proposal.subject.assignmentId },
		]);
		// Sentinels: every byte outside the advisory directory is unchanged; no route claim exists anywhere.
		const after = snapshotOutsideAdvisory(root);
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [p, bytes] of before) expect(after.get(p), p).toBe(bytes);
		const all: string[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true }))
				e.isDirectory() ? walk(join(d, e.name)) : all.push(e.name);
		};
		walk(root);
		walk(repo);
		expect(all.some((n) => n.endsWith(".route.json"))).toBe(false);
		expect(run.calls).toHaveLength(1);
		// Acknowledgement changes the advisory queue only.
		const ack = ok(decideEndoAdvisoryProposalV0(root, entry!.proposal.proposalId, "acknowledged", "seen", clock.now));
		expect(ack.authority).toEqual({ grants: "none", affects: "advisory-queue-only" });
		const afterAck = snapshotOutsideAdvisory(root);
		for (const [p, bytes] of before) expect(afterAck.get(p), p).toBe(bytes);
		expect(
			decideEndoAdvisoryProposalV0(root, entry!.proposal.proposalId, "dismissed", null, clock.now),
		).toMatchObject({ ok: false, code: "already-decided" });
		expect(readEndoAdvisoryProjectionV0(root, { now: clock.now }).proposals[0]).toMatchObject({
			queueState: "acknowledged",
		});
	});

	it("S2-18: equivalent proposals deduplicate, newer evidence supersedes, and stale ones stay visible as stale", async () => {
		const root = tmp("endo-s2-18-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		const extra = ok(new DevelopTasksStoreV0(root).createTask(projectId, { title: "Other" }));
		setStatus(root, projectId, taskId, "in-progress", "blocked");
		configure(root, clock, { projectId, action: "emit-operator-proposal", wake: "digest-window" });
		const run = fakeRun({ answer: () => `- Blocked.\nPROPOSAL: resolve-blocked-task ${taskId}` });
		const obs = observer("ready", clock);
		clock.at(windowAt(0));
		await tick(root, clock, run, obs);
		clock.at(windowAt(1));
		await tick(root, clock, run, obs);
		expect(listTurns(root).map((t) => t.briefing!.proposal.outcome)).toEqual(["deduplicated", "created"]);
		expect(listProposals(root)).toHaveLength(1);
		// Unrelated change: the same recommendation is re-grounded on new evidence and supersedes the old record.
		setStatus(root, projectId, extra.id, "in-progress");
		clock.at(windowAt(2));
		await tick(root, clock, run, obs);
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now });
		expect(view.proposals.map((p) => p.queueState)).toEqual(["pending", "superseded"]);
		expect(view.proposals.map((p) => p.currency)).toEqual(["current", "stale"]);
		// Partial publication: a proposal linked without its briefing (crash) is still a bounded, visible, untrusted record.
		expect(listTurns(root).every((t) => t.briefing !== null)).toBe(true);
	});

	it("S2-20, S0-AT11: Pi/Codex event writes and task mutations proceed while advisory inference is in flight", async () => {
		const root = tmp("endo-s2-20-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		configure(root, clock, { projectId });
		let wrote = false;
		const run = fakeRun({
			during: async () => {
				const release = acquireEndoEventStoreWriterLockV0(root, "pi.live-session");
				try {
					const events = createEndoDurableEventStoreV0(root);
					events.close();
				} finally {
					release();
				}
				setStatus(root, projectId, taskId, "in-progress");
				wrote = true;
			},
		});
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual(["briefing-published"]);
		expect(wrote).toBe(true);
	});

	it("S2-21: schedules for different projects are isolated in scope, budget and digest", async () => {
		const root = tmp("endo-s2-21-");
		const clock = new Clock();
		const a = project(root, "a");
		const b = project(root, "b");
		configure(root, clock, { projectId: a.projectId, scheduleId: "adv-a" });
		configure(root, clock, { projectId: b.projectId, scheduleId: "adv-b" });
		const run = fakeRun();
		const obs = observer("ready", clock);
		clock.at(windowAt(0));
		await tick(root, clock, run, obs);
		clock.at(windowAt(0) + 2_000);
		await tick(root, clock, run, obs);
		expect(run.calls.map((c) => c.projectId).sort()).toEqual([a.projectId, b.projectId].sort());
		// A change in b does not wake a.
		setStatus(root, b.projectId, b.taskId, "in-progress");
		clock.at(windowAt(1));
		const r1 = await tick(root, clock, run, obs);
		clock.at(windowAt(1) + 2_000);
		const r2 = await tick(root, clock, run, obs);
		const byId = Object.fromEntries(
			[...(r1.ok ? r1.outcomes : []), ...(r2.ok ? r2.outcomes : [])].map((o) => [o.scheduleId, o.status]),
		);
		expect(byId).toEqual({ "adv-a": "skipped-unchanged", "adv-b": "briefing-published" });
		expect(run.calls).toHaveLength(3);
	});

	it("S2-1, S2-22: S1 schedules stay zero-token and S1 files are untouched by S2", async () => {
		const root = tmp("endo-s2-1-");
		const clock = new Clock();
		const { projectId } = project(root);
		const s1 = new DevelopAutomationStoreV0(root, { now: clock.now });
		ok(
			s1.addSchedule({
				scheduleId: "s1-observe",
				actionKind: "observe-health",
				trigger: { kind: "interval", everyMs: 15 * MIN, anchorMs: BASE },
				missedRunPolicy: "skip-and-report",
				label: null,
				enabled: true,
			}) as never,
		);
		const s1Schedules = readFileSync(join(root, "develop", "automation", "schedules.json"), "utf8");
		configure(root, clock, { projectId });
		clock.at(windowAt(0));
		const run = fakeRun();
		await tick(root, clock, run, observer("ready", clock));
		expect(readFileSync(join(root, "develop", "automation", "schedules.json"), "utf8")).toBe(s1Schedules);
		const s1tick = await runEndoSchedulerTickV0({ root, now: clock.now });
		expect(s1tick).toMatchObject({ ok: true, tokensConsumed: 0 });
		expect(run.calls).toHaveLength(1);
		expect(existsSync(join(root, "develop", "automation", "advisory", "schedules.json"))).toBe(true);
	});

	it("S2-11: concurrent processes cannot double-admit the same fire or budget", async () => {
		const root = tmp("endo-s2-11-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId, wake: "digest-window", budget: { maxTurnsPerPeriod: 1 } });
		const callsFile = join(tmp("endo-s2-11-calls-"), "calls.log");
		writeFileSync(callsFile, "", "utf8");
		const workers = Array.from(
			{ length: 4 },
			(_, i) =>
				new Promise<{ code: number | null; out: string }>((res) => {
					const child = spawn(
						process.execPath,
						[WORKER, JSON.stringify({ root, nowMs: windowAt(0), holderId: `w-${i}`, callsFile })],
						{
							cwd: REPO_ROOT,
							stdio: ["ignore", "pipe", "pipe"],
						},
					);
					let out = "";
					child.stdout.on("data", (d) => {
						out += d;
					});
					child.stderr.on("data", (d) => {
						out += d;
					});
					child.on("close", (code) => res({ code, out }));
				}),
		);
		const results = await Promise.all(workers);
		for (const r of results) expect(r.code, r.out).toBe(0);
		const parsed = results.map((r) => JSON.parse(r.out.trim().split("\n").at(-1)!));
		expect(parsed.filter((p) => p.ok && p.turnId !== null)).toHaveLength(1);
		expect(readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
		expect(listTurns(root)).toHaveLength(1);
		// The next window is refused by the budget, for every racer.
		const more = Array.from(
			{ length: 3 },
			(_, i) =>
				new Promise<number | null>((res) =>
					spawn(
						process.execPath,
						[WORKER, JSON.stringify({ root, nowMs: windowAt(1), holderId: `v-${i}`, callsFile })],
						{ cwd: REPO_ROOT, stdio: "ignore" },
					).on("close", res),
				),
		);
		await Promise.all(more);
		expect(readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
	}, 60_000);

	it("S2-23: a simulated idle 24 hours with three changes makes exactly four inference turns", async () => {
		const root = tmp("endo-s2-23-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		configure(root, clock, { projectId, budget: { maxTurnsPerPeriod: 8 } });
		const run = fakeRun();
		const obs = observer("ready", clock);
		const changes = new Map<number, string[]>([
			[20, ["in-progress"]],
			[50, ["blocked"]],
			[80, ["in-progress", "review"]],
		]);
		const tally: Record<string, number> = {};
		for (let k = 0; k < 96; k++) {
			const change = changes.get(k);
			if (change !== undefined) setStatus(root, projectId, taskId, ...change);
			clock.at(windowAt(k));
			for (const s of statusOf(await tick(root, clock, run, obs))) tally[s] = (tally[s] ?? 0) + 1;
		}
		expect(tally).toEqual({ "briefing-published": 4, "skipped-unchanged": 92 });
		expect(run.calls).toHaveLength(4);
		expect(obs.calls).toHaveLength(4);
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now });
		expect(view.schedules[0]!.budget).toMatchObject({
			turnsCharged: 4,
			generatedTokensCharged: 800,
			uncertainTurns: 0,
		});
	}, 60_000);
});

describe("COORDINATOR-AUTOMATION-S2 storage, retention and CLI", () => {
	it("S2-12: a failure after the briefing but before the fire outcome is recovered from the briefing, never re-run", async () => {
		const root = tmp("endo-s2-12d-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId });
		const run = fakeRun();
		clock.at(windowAt(0));
		const r = await tick(root, clock, run, observer("ready", clock), {
			storeOptions: {
				beforeRecordLink: (name) => {
					if (name.endsWith(".outcome.json")) throw new Error("EIO at outcome link");
				},
			},
		});
		expect(r).toMatchObject({ ok: true, inferenceDispatched: true, outcomes: [] });
		expect(listTurns(root)[0]!.briefing).toMatchObject({ availability: "available" });
		clock.at(windowAt(0) + 1_000);
		const recovered = await tick(root, clock, run, observer("ready", clock));
		expect(recovered.ok && recovered.outcomes).toEqual([
			expect.objectContaining({ status: "briefing-published", inferenceDispatched: "yes" }),
		]);
		expect(run.calls).toHaveLength(1);
	});

	it("S2-12, S2-18: a failed proposal link is recorded honestly on the briefing and leaves no partial proposal", async () => {
		const root = tmp("endo-s2-18b-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		setStatus(root, projectId, taskId, "in-progress", "blocked");
		configure(root, clock, { projectId, action: "emit-operator-proposal" });
		clock.at(windowAt(0));
		const run = fakeRun({ answer: () => `- Blocked.\nPROPOSAL: resolve-blocked-task ${taskId}` });
		await tick(root, clock, run, observer("ready", clock), {
			storeOptions: {
				beforeRecordLink: (name) => {
					if (/^[0-9a-f]{64}\.json$/.test(name)) throw new Error("EIO at proposal link");
				},
			},
		});
		expect(listTurns(root)[0]!.briefing!.proposal).toEqual({
			outcome: "refused",
			proposalId: null,
			refusal: "storage-failed",
		});
		expect(listProposals(root)).toHaveLength(0);
		const leftovers = readdirSync(new DevelopAdvisoryStoreV0(root).proposalsDir).filter(
			(n) => !n.startsWith(".tmp-"),
		);
		expect(leftovers).toEqual([]);
	});

	it("S2-18: retention keeps every pending proposal and unresolved claim, and bounds the rest", async () => {
		const root = tmp("endo-s2-18c-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		setStatus(root, projectId, taskId, "in-progress", "blocked");
		configure(root, clock, { projectId, action: "emit-operator-proposal" });
		clock.at(windowAt(0));
		await tick(
			root,
			clock,
			fakeRun({ answer: () => `PROPOSAL: resolve-blocked-task ${taskId}` }),
			observer("ready", clock),
		);
		const [seed] = listProposals(root);
		const store = new DevelopAdvisoryStoreV0(root, { now: clock.now });
		const hex = (i: number, salt: string) => (salt + i.toString(16)).padStart(64, "0");
		const locked = store.withAdvisoryLockSync((s) => {
			for (let i = 1; i <= 300; i++) {
				const proposalId = hex(i, "a");
				s.writeProposalOnce({ ...seed!.proposal, proposalId, dedupKey: hex(i, "d"), generatedAtMs: BASE + i });
				s.writeProposalStateOnce({
					schemaVersion: "endo.develop-advisory-proposal-state.v0",
					proposalId,
					disposition: "dismissed",
					decidedAtMs: BASE + i,
					note: null,
					authority: { grants: "none", affects: "advisory-queue-only" },
				});
			}
			return s.pruneRetained(clock.t);
		});
		expect(locked).toMatchObject({ ok: true, result: { proposals: 45 } });
		const after = listProposals(root);
		expect(after).toHaveLength(256);
		expect(after.some((e) => e.proposal.proposalId === seed!.proposal.proposalId)).toBe(true);
	});

	it("unsafe advisory paths fail closed and are never followed", async () => {
		const root = tmp("endo-s2-unsafe-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId });
		const dir = new DevelopAdvisoryStoreV0(root).dir;
		const elsewhere = tmp("endo-s2-elsewhere-");
		rmSync(dir, { recursive: true, force: true });
		const { symlinkSync } = await import("node:fs");
		symlinkSync(elsewhere, dir);
		clock.at(windowAt(0));
		const run = fakeRun();
		const r = await tick(root, clock, run, observer("ready", clock));
		expect(r).toMatchObject({ ok: false });
		expect(run.calls).toHaveLength(0);
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	it("CLI: add creates a disabled schedule; authorize needs the exact enabled revision and explicit ceilings; tick with nothing due is zero-token", () => {
		const root = tmp("endo-s2-cli-");
		const { projectId } = project(root);
		const poolFile = join(tmp("endo-s2-cli-pool-"), "pool.json");
		writeFileSync(poolFile, JSON.stringify(pool()), "utf8");
		const cli = (...args: string[]) =>
			spawnSync(process.execPath, [join(REPO_ROOT, "cli", "index.ts"), "advisory", ...args], {
				encoding: "utf8",
				env: { ...process.env },
			});
		const added = cli(
			"add",
			"--root",
			root,
			"--id",
			"adv-cli",
			"--project",
			projectId,
			"--action",
			"generate-advisory-brief",
			"--wake",
			"on-change",
			"--every",
			"1h",
			"--quiet",
		);
		expect(added.status, added.stderr).toBe(0);
		expect(JSON.parse(added.stdout).schedule).toMatchObject({ enabled: false, revision: 1 });
		const ceilings = [
			"--period",
			"24h",
			"--max-turns",
			"4",
			"--max-output-tokens",
			"512",
			"--max-generated-tokens",
			"4096",
			"--turn-timeout",
			"60",
			"--expires-in",
			"24h",
		];
		const early = cli(
			"authorize",
			"--root",
			root,
			"--id",
			"adv-cli",
			"--revision",
			"1",
			"--pool",
			poolFile,
			...ceilings,
			"--quiet",
		);
		expect(early.status).not.toBe(0);
		expect(early.stdout).toContain("not-enabled");
		expect(cli("enable", "--root", root, "--id", "adv-cli", "--revision", "1", "--quiet").status).toBe(0);
		const missing = cli(
			"authorize",
			"--root",
			root,
			"--id",
			"adv-cli",
			"--revision",
			"2",
			"--pool",
			poolFile,
			"--quiet",
		);
		expect(missing.status).not.toBe(0);
		const granted = cli(
			"authorize",
			"--root",
			root,
			"--id",
			"adv-cli",
			"--revision",
			"2",
			"--pool",
			poolFile,
			...ceilings,
			"--quiet",
		);
		expect(granted.status, granted.stderr).toBe(0);
		expect(JSON.parse(granted.stdout).authorization).toMatchObject({ scheduleRevision: 2, revokedAtMs: null });
		const ticked = cli("tick", "--root", root, "--quiet");
		expect(ticked.status, ticked.stderr).toBe(0);
		expect(JSON.parse(ticked.stdout).tick).toMatchObject({ ok: true, inferenceDispatched: false, outcomes: [] });
		const listed = JSON.parse(cli("list", "--root", root, "--quiet").stdout);
		expect(listed.advisory.schedules[0].authorization.ok).toBe(true);
		expect(listed.advisory.schedules[0].budget).toMatchObject({ turnsCharged: 0, admissible: true });
		expect(cli("revoke", "--root", root, "--id", "adv-cli", "--quiet").status).toBe(0);
		expect(JSON.parse(cli("list", "--root", root, "--quiet").stdout).advisory.schedules[0].authorization).toEqual({
			ok: false,
			refusal: "authorization-revoked",
		});
		expect(JSON.parse(cli("proposals", "--root", root, "--quiet").stdout).proposals).toEqual([]);
	}, 60_000);
});

describe("COORDINATOR-AUTOMATION-S2 independent-review regressions (R02, R04, R05, R09-R12)", () => {
	it("R09: a proposal's queue currency follows the publication observation, not only the admission one", async () => {
		const root = tmp("endo-s2-r09-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		setStatus(root, projectId, taskId, "in-progress", "blocked");
		configure(root, clock, { projectId, action: "emit-operator-proposal", wake: "digest-window" });
		clock.at(windowAt(0));
		await tick(
			root,
			clock,
			fakeRun({ answer: () => `PROPOSAL: resolve-blocked-task ${taskId}` }),
			observer("ready", clock),
		);
		expect(readEndoAdvisoryProjectionV0(root, { now: clock.now }).proposals[0]!.currency).toBe("current");
		clock.at(windowAt(1));
		await tick(
			root,
			clock,
			fakeRun({ during: () => setStatus(root, projectId, taskId, "in-progress") }),
			observer("ready", clock),
		);
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now });
		expect(view.briefings[0]!.source.currency).toBe("stale-at-publication");
		expect(view.proposals[0]!.currency).toBe("stale");
	});

	it("R11: a claim that fails to link consumes no window and reports failure", async () => {
		const root = tmp("endo-s2-r11-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId });
		clock.at(windowAt(0));
		const run = fakeRun();
		const r = await tick(root, clock, run, observer("ready", clock), {
			storeOptions: {
				beforeRecordLink: (name) => {
					if (name.endsWith(".claimed.json")) throw new Error("simulated I/O failure");
				},
			},
		});
		expect(r).toMatchObject({ ok: false, refusal: "storage-failed" });
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now });
		expect(view.fires).toHaveLength(0);
		expect(view.schedules[0]!.schedule.cursor.lastConsumedWindowStartMs).toBeNull();
		expect(run.calls).toHaveLength(0);
	});

	it("R12: an unauthorized co-due schedule cannot starve an authorized one", async () => {
		const root = tmp("endo-s2-r12-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId, scheduleId: "first", authorize: false });
		configure(root, clock, { projectId, scheduleId: "second" });
		const run = fakeRun();
		for (let k = 0; k < 4; k++) {
			clock.at(windowAt(k));
			await tick(root, clock, run, observer("ready", clock));
		}
		expect(run.calls.length).toBeGreaterThan(0);
	});

	it("R02: an unreadable record in the turn ledger refuses admission instead of undercounting", async () => {
		const root = tmp("endo-s2-r02-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId, wake: "digest-window" });
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, fakeRun(), observer("ready", clock)))).toEqual(["briefing-published"]);
		const [turn] = listTurns(root);
		const dispatched = join(new DevelopAdvisoryStoreV0(root).turnsDir, `${turn!.admission.turnId}.dispatched.json`);
		rmSync(dispatched);
		writeFileSync(dispatched, "{not json");
		clock.at(windowAt(1));
		const run = fakeRun();
		await tick(root, clock, run, observer("ready", clock));
		expect(run.calls).toHaveLength(0);
		expect(readEndoAdvisoryProjectionV0(root, { now: clock.now }).schedules[0]!.budget).toBeNull();
	});

	it("R04: monotonic lease age fences dispatch even when the wall clock says the lease is live", async () => {
		const root = tmp("endo-s2-r04-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId });
		clock.at(windowAt(0));
		let mono = 0;
		const obs = observer("ready", clock);
		const run = fakeRun();
		await tick(
			root,
			clock,
			run,
			{
				...obs,
				observe: (async (...args: Parameters<typeof obs.observe>) => {
					mono = 301_000;
					return obs.observe(...args);
				}) as typeof obs.observe,
			},
			{ monotonicNow: () => mono },
		);
		expect(run.calls).toHaveLength(0);
		expect(listTurns(root).every((t) => t.dispatch === null)).toBe(true);
	});

	it("R05: a dispatch record whose directory fsync fails is not treated as durable, so nothing is sent", async () => {
		const root = tmp("endo-s2-r05-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId });
		clock.at(windowAt(0));
		const turnsDir = new DevelopAdvisoryStoreV0(root).turnsDir;
		let linked = false;
		const run = fakeRun();
		await tick(root, clock, run, observer("ready", clock), {
			storeOptions: {
				beforeRecordLink: (name) => {
					if (name.endsWith(".dispatched.json")) linked = true;
				},
				beforeDirectorySync: (dir) => {
					if (linked && dir === turnsDir) throw new Error("simulated fsync failure");
				},
			},
		});
		expect(linked).toBe(true);
		expect(run.calls).toHaveLength(0);
	});

	it("R10: a budget compaction floor ahead of the clock makes the ledger indeterminate, so nothing is admitted", async () => {
		const root = tmp("endo-s2-r10-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId });
		const store = new DevelopAdvisoryStoreV0(root);
		writeFileSync(
			join(store.dir, "budget-floor.json"),
			`${JSON.stringify({ schemaVersion: "endo.advisory-budget-floor.v0", nowMs: BASE + 48 * HOUR })}\n`,
		);
		clock.at(windowAt(0));
		const run = fakeRun();
		await tick(root, clock, run, observer("ready", clock));
		expect(run.calls).toHaveLength(0);
		const t = store.listTurns(clock.t);
		expect(t.ok && t.problems.some((p) => p.name === "budget-floor.json")).toBe(true);
	});
});

describe("COORDINATOR-AUTOMATION-S2 Codex review regressions (C1-C3)", () => {
	const shiftTimes = (value: unknown, delta: number): unknown => {
		if (Array.isArray(value)) return value.map((v) => shiftTimes(v, delta));
		if (value === null || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [
				k,
				typeof v === "number" && v >= BASE - 30 * 24 * HOUR && /(?:AtMs|DeadlineMs)$/.test(k)
					? v + delta
					: shiftTimes(v, delta),
			]),
		);
	};

	it("C1: a ledger past the old 4096-entry bound at a realistic rate still admits, and spend stays exact", async () => {
		const root = tmp("endo-s2-c1-");
		const clock = new Clock();
		const { projectId } = project(root);
		configure(root, clock, { projectId, wake: "digest-window" });
		clock.at(windowAt(0));
		expect(statusOf(await tick(root, clock, fakeRun(), observer("ready", clock)))).toEqual(["briefing-published"]);
		const store = new DevelopAdvisoryStoreV0(root);
		const [seed] = listTurns(root);
		const seedCharge = seed!.briefing!.accounting.chargedGeneratedTokens;
		const records = ["admitted", "dispatched", "briefing"].map((kind) => [
			kind,
			JSON.parse(readFileSync(join(store.turnsDir, seed!.admission.turnId + "." + kind + ".json"), "utf8")),
		]) as [string, Record<string, unknown>][];
		// Another schedule's history: one settled turn every 5 minutes for the last ~6.9 days (2000 turns, 6000 records).
		const clones = 2000;
		for (let i = 1; i <= clones; i++) {
			const turnId = sha256HexV0("c1-clone-" + i);
			const delta = -i * 5 * MIN;
			for (const [kind, record] of records) {
				const clone = { ...(shiftTimes(record, delta) as Record<string, unknown>), turnId };
				if ("scheduleId" in clone) clone.scheduleId = "adv-other";
				writeFileSync(
					join(store.turnsDir, turnId + "." + kind + ".json"),
					canonicalEndoJsonV0(clone as never) + "\n",
				);
			}
		}
		expect(readdirSync(store.turnsDir).length).toBeGreaterThan(4096);
		const before = store.listTurns(clock.t);
		expect(before).toMatchObject({ ok: true, problems: [] });
		clock.at(windowAt(1));
		const run = fakeRun();
		expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual(["briefing-published"]);
		expect(run.calls).toHaveLength(1);
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now });
		expect(view.problems).toEqual([]);
		const fresh = listTurns(root).find((t) => t.admission.admittedAtMs === windowAt(1));
		expect(view.schedules[0]!.budget).toMatchObject({
			turnsCharged: 2,
			generatedTokensCharged: seedCharge + fresh!.briefing!.accounting.chargedGeneratedTokens,
		});
		const after = store.listTurns(clock.t);
		if (!after.ok) throw new Error("ledger unreadable");
		expect(after.entries).toHaveLength(clones + 2);
		const other = endoAdvisoryBudgetStandingV0({
			turns: after.entries.filter((t) => t.admission.scheduleId === "adv-other"),
			budget: { ...BUDGET, periodMs: 7 * 24 * HOUR },
			nowMs: clock.t,
			currentLease: null,
		});
		expect(other).toMatchObject({ turnsCharged: clones, generatedTokensCharged: clones * seedCharge });
	}, 120_000);

	it("C2: every pending proposal is listed and can be acknowledged; a truncated history says what it withheld", async () => {
		const root = tmp("endo-s2-c2-");
		const clock = new Clock();
		const { projectId, taskId } = project(root);
		setStatus(root, projectId, taskId, "in-progress", "blocked");
		configure(root, clock, { projectId, action: "emit-operator-proposal" });
		clock.at(windowAt(0));
		await tick(
			root,
			clock,
			fakeRun({ answer: () => "PROPOSAL: resolve-blocked-task " + taskId }),
			observer("ready", clock),
		);
		const [seed] = listProposals(root);
		const store = new DevelopAdvisoryStoreV0(root, { now: clock.now });
		const hex = (i: number, salt: string) => (salt + i.toString(16)).padStart(64, "0");
		const pendingClones = 300;
		const locked = store.withAdvisoryLockSync((s) => {
			for (let i = 1; i <= pendingClones; i++)
				s.writeProposalOnce({
					...seed!.proposal,
					proposalId: hex(i, "a"),
					dedupKey: hex(i, "d"),
					generatedAtMs: BASE - i,
				});
			for (let i = 1; i <= 20; i++) {
				const proposalId = hex(i, "b");
				s.writeProposalOnce({
					...seed!.proposal,
					proposalId,
					dedupKey: hex(i, "e"),
					generatedAtMs: BASE - 1000 - i,
				});
				s.writeProposalStateOnce({
					schemaVersion: "endo.develop-advisory-proposal-state.v0",
					proposalId,
					disposition: "dismissed",
					decidedAtMs: BASE,
					note: null,
					authority: { grants: "none", affects: "advisory-queue-only" },
				});
			}
			return true;
		});
		expect(locked).toMatchObject({ ok: true });
		const view = readEndoAdvisoryProjectionV0(root, { now: clock.now, limit: 5 });
		const pending = view.proposals.filter((v) => v.queueState === "pending");
		expect(pending).toHaveLength(pendingClones + 1);
		expect(view.proposalCounts).toMatchObject({ pending: pendingClones + 1, withheld: 15 });
		expect(view.proposalCounts.withheldHint).toMatch(/15 decided or superseded proposal\(s\) not listed/);
		const oldest = hex(pendingClones, "a");
		expect(pending.some((v) => v.proposal.proposalId === oldest)).toBe(true);
		const cli = (...args: string[]) =>
			spawnSync(process.execPath, [join(REPO_ROOT, "cli", "index.ts"), "advisory", ...args], {
				encoding: "utf8",
				env: { ...process.env },
			});
		const listed = cli("proposals", "--root", root, "--limit", "5", "--quiet");
		expect(listed.status, listed.stderr).toBe(0);
		const out = JSON.parse(listed.stdout);
		expect(out.proposals).toHaveLength(pendingClones + 1);
		expect(out.proposalCounts.withheld).toBe(15);
		expect(cli("ack", "--root", root, "--proposal", oldest, "--quiet").status).toBe(0);
		const acked = readEndoAdvisoryProjectionV0(root, { now: clock.now, limit: 256 });
		expect(acked.proposals.find((v) => v.proposal.proposalId === oldest)?.queueState).toBe("acknowledged");
		expect(acked.proposalCounts).toMatchObject({ pending: pendingClones, withheld: 0, withheldHint: null });
	}, 60_000);

	it("C3: a readable Git project's HEAD is observed, the observation is complete, and the pinned runner sees that HEAD", async () => {
		const root = tmp("endo-s2-c3-");
		const clock = new Clock();
		const { projectId, repo } = project(root);
		const git = (...args: string[]) => {
			const r = spawnSync(
				"/usr/bin/git",
				["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
				{
					cwd: repo,
					encoding: "utf8",
					env: { PATH: process.env.PATH ?? "/usr/bin", HOME: repo, GIT_CONFIG_NOSYSTEM: "1" },
				},
			);
			if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr);
			return r.stdout.trim();
		};
		git("init", "-q");
		writeFileSync(join(repo, "README"), "s2\n");
		git("add", "README");
		git("commit", "-q", "-m", "init");
		const commit = git("rev-parse", "HEAD");
		// A store whose other sources are present and readable, so HEAD is the only thing under test.
		mkdirSync(new DevelopAttemptsStoreV0(root).directory, { recursive: true });
		mkdirSync(join(root, "events"), { recursive: true });
		writeFileSync(join(root, "events", "events.log"), "");
		const read = await defaultObserveAdvisoryProjectV0({ root, projectId, nowMs: BASE });
		expect(read.status.projects[0]!.head).toMatchObject({ commit, clean: true });
		const observation = endoAdvisorySemanticObservationV0(projectId, read.status, read.coordination);
		expect(observation.gaps).not.toContain("finding-project-head-unavailable");
		expect(observation.completeness).toBe("complete");
		configure(root, clock, { projectId, policy: { permitPartialObservation: false } });
		clock.at(windowAt(0));
		const base = fakeRun();
		let seenHead: string | null | undefined;
		const run = {
			...base,
			run: (async (r: string, q: never, o: Record<string, any>) => {
				seenHead = o.pinnedObservation?.status.projects[0]?.head?.commit ?? null;
				return (base.run as any)(r, q, o);
			}) as unknown as typeof base.run,
		};
		expect(statusOf(await tick(root, clock, run, observer("ready", clock)))).toEqual(["briefing-published"]);
		expect(base.calls).toHaveLength(1);
		expect(seenHead).toBe(commit);
	});

	it("C3: an unreadable HEAD stays honest: the project reads head-unavailable and the observation is partial", async () => {
		const root = tmp("endo-s2-c3b-");
		const { projectId } = project(root);
		const read = await defaultObserveAdvisoryProjectV0({ root, projectId, nowMs: BASE });
		expect(read.status.projects[0]!.head).toBeNull();
		const observation = endoAdvisorySemanticObservationV0(projectId, read.status, read.coordination);
		expect(observation.gaps).toContain("finding-project-head-unavailable");
		expect(observation.completeness).toBe("partial");
	});
});
