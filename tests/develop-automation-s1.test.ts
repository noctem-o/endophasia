// Comprehensive S1 Acceptance & Adversarial Test Suite (`COORDINATOR-AUTOMATION-S1`):
// Covers S0-AT01, S0-AT03, S0-AT04, S0-AT05, S0-AT06, S0-AT08, S0-AT11 and S1-AT01 through S1-AT20,
// including real multi-process OS races, pre-E4 writer-lock non-interference, passive llama.cpp
// prohibited-route sentinels, crash-boundary injections, DST transitions, retention safety, and CLI/systemd checks.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runEndoSchedulerTickV0 } from "../adapters/develop/scheduler-tick.ts";
import {
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
	type EndoCoordinatorModelPoolV0,
	parseEndoCoordinatorModelPoolV0,
} from "../protocol/coordinator-model-pool.ts";
import {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULES_SCHEMA_V0,
	parseEndoDevelopAutomationLeaseV0,
	parseEndoDevelopSchedulesFileV0,
	validateEndoDevelopResourceObservationV0,
} from "../protocol/develop-automation.ts";
import { coordinatorModelPoolSha256V0, selectCoordinatorModelV0 } from "../runtime/contracts/coordinator-model-pool.ts";
import {
	createRecordedCoordinatorModelObserverV0,
	endoEffectiveProviderAllowanceV0,
	endoScheduleFireIdempotencyKeyV0,
	endoScheduleTriggerCursorV0,
	escapeEndoSystemdExecArgV0,
	evaluateEndoScheduleDueV0,
	evaluateRecordedPoolObservationV0,
	parseEndoCalendarSpecV0,
	parseEndoDurationMsV0,
	parseEndoStrictIsoTimestampMsV0,
	renderEndoSystemdUnitsV0,
	resolveEndoLocalWallTimeUtcMsV0,
} from "../runtime/contracts/develop-automation.ts";
import { DevelopAutomationStoreV0, readEndoAutomationProjectionV0 } from "../storage/develop-automation.ts";
import { DevelopCoordinationStoreV0 } from "../storage/develop-coordination.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { acquireEndoEventStoreWriterLockV0 } from "../storage/writer-lock.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, "cli", "index.ts");
const WORKER_SCRIPT = join(REPO_ROOT, "tests", "fixtures", "s1-tick-worker.ts");

const temps: string[] = [];
const servers: Server[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

interface FakeServerHit {
	readonly method: string;
	readonly url: string;
}

async function startFakeServer(
	handler: (req: IncomingMessage, res: ServerResponse, hits: FakeServerHit[]) => void,
): Promise<{
	readonly port: number;
	readonly endpoint: string;
	readonly hits: FakeServerHit[];
	close(): Promise<void>;
}> {
	const hits: FakeServerHit[] = [];
	const server = createServer((req, res) => {
		hits.push({ method: req.method ?? "GET", url: req.url ?? "/" });
		handler(req, res, hits);
	});
	servers.push(server);
	await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
	const addr = server.address();
	const port = typeof addr === "object" && addr !== null ? addr.port : 0;
	return {
		port,
		endpoint: `http://127.0.0.1:${port}`,
		hits,
		close: () => new Promise<void>((res) => server.close(() => res())),
	};
}

function makePool(
	members: {
		memberId: string;
		endpoint: string;
		modelId: string;
		kind?: "local-openai-compat" | "hosted-relay";
		priority?: number;
	}[],
): EndoCoordinatorModelPoolV0 {
	return parseEndoCoordinatorModelPoolV0({
		schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
		selection: { fallback: "availability", unconfirmedModel: "permit" },
		members: members.map((m, idx) => ({
			memberId: m.memberId,
			kind: m.kind ?? "local-openai-compat",
			endpoint: m.endpoint,
			modelId: m.modelId,
			priority: m.priority ?? 100 - idx,
			maxPromptBytes: 4096,
			maxOutputTokens: 1024,
			timeoutMs: 30_000,
			advisoryOnly: true,
		})),
	});
}

function fingerprintTree(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) {
				out.push(`${relative(dir, p)}/`);
				walk(p);
			} else {
				const h = createHash("sha256").update(readFileSync(p)).digest("hex");
				out.push(`${relative(dir, p)} ${h}`);
			}
		}
	};
	walk(dir);
	return out.sort();
}

function runCli(args: readonly string[], envOverrides: Record<string, string> = {}) {
	return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...envOverrides },
		timeout: 20_000,
	});
}

function runCliAsync(
	args: readonly string[],
	envOverrides: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
			env: { ...process.env, ...envOverrides },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
	});
}

function spawnWorker(
	config: Record<string, unknown>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [WORKER_SCRIPT, JSON.stringify(config)], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

afterEach(async () => {
	while (servers.length > 0) {
		const srv = servers.pop()!;
		await new Promise<void>((res) => srv.close(() => res()));
	}
	while (temps.length > 0) {
		const d = temps.pop()!;
		rmSync(d, { recursive: true, force: true });
	}
});

const BASE_MS = Date.parse("2026-11-26T12:00:00Z");

describe("COORDINATOR-AUTOMATION-S1 Acceptance Matrix", () => {
	it("S1-AT01: disabled by default — ordinary commands create zero automation files and start no services", () => {
		const home = makeTempDir("endo-s1-home-");
		const storeRoot = join(home, "empty-store");
		const env = { HOME: home, XDG_DATA_HOME: join(home, "xdg-data"), XDG_CONFIG_HOME: join(home, "xdg-config") };

		const help = runCli(["--help"], env);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("schedule <add|list|enable|disable|remove>");
		expect(help.stdout).toContain("scheduler tick");
		expect(help.stdout).toContain("scheduler print-systemd-unit");
		expect(help.stdout).toContain("resource <declare-window|list>");

		const list = runCli(["schedule", "list", "--root", storeRoot, "--quiet"], env);
		expect(list.status).toBe(0);
		const parsed = JSON.parse(list.stdout) as {
			automation: { schedules: { state: string }; lease: { state: string } };
		};
		expect(parsed.automation.schedules.state).toBe("absent");
		expect(parsed.automation.lease.state).toBe("absent");
		expect(existsSync(storeRoot)).toBe(false);
		expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
	});

	it("S1-AT02: schedule validation refuses malformed, oversized, ambiguous, and unsafe schedules without side effects", () => {
		const root = makeTempDir("endo-s1-at02-");
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });

		// Invalid schedule IDs
		for (const badId of ["../escape", "bad/id", "UPPER", "has space", "", "a".repeat(65), "-leading"]) {
			const res = store.addSchedule({
				scheduleId: badId,
				actionKind: "observe-health",
				trigger: { kind: "once", atMs: BASE_MS + 60_000 },
			});
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.code).toBe("bad-request");
		}

		// Unsupported action kind / executable fields rejected by protocol parser
		expect(() =>
			parseEndoDevelopSchedulesFileV0({
				schemaVersion: ENDO_DEVELOP_SCHEDULES_SCHEMA_V0,
				revision: 1,
				updatedAtMs: BASE_MS,
				retiredCursors: [],
				schedules: [
					{
						scheduleId: "evil",
						label: null,
						revision: 1,
						enabled: true,
						actionKind: "dispatch-agent",
						missedRunPolicy: "skip-and-report",
						trigger: { kind: "once", atMs: BASE_MS + 1000 },
						createdAtMs: BASE_MS,
						updatedAtMs: BASE_MS,
						cursor: {
							lastEvaluatedAtMs: null,
							lastConsumedWindowStartMs: null,
							completedOnce: false,
							lastFireIdempotencyKey: null,
							lastFireStatus: null,
						},
					},
				],
			}),
		).toThrow();

		// Extra command/shell/callback field refused (closed schema)
		expect(() =>
			parseEndoDevelopSchedulesFileV0({
				schemaVersion: ENDO_DEVELOP_SCHEDULES_SCHEMA_V0,
				revision: 1,
				updatedAtMs: BASE_MS,
				retiredCursors: [],
				schedules: [
					{
						scheduleId: "cmd",
						label: null,
						revision: 1,
						enabled: true,
						actionKind: "observe-health",
						missedRunPolicy: "skip-and-report",
						trigger: { kind: "once", atMs: BASE_MS + 1000 },
						command: "rm -rf /",
						createdAtMs: BASE_MS,
						updatedAtMs: BASE_MS,
						cursor: {
							lastEvaluatedAtMs: null,
							lastConsumedWindowStartMs: null,
							completedOnce: false,
							lastFireIdempotencyKey: null,
							lastFireStatus: null,
						},
					},
				],
			}),
		).toThrow(/unknown field/);

		// Ambiguous timestamps, bad durations, bad calendar specs
		expect(() => parseEndoStrictIsoTimestampMsV0("2026-11-26T12:00:00")).toThrow(/explicit timezone/);
		expect(() => parseEndoStrictIsoTimestampMsV0("2026-02-30T12:00:00Z")).toThrow(/not a real calendar date/);
		expect(() => parseEndoDurationMsV0("0s")).toThrow();
		expect(() => parseEndoCalendarSpecV0("*/5 * * * *")).toThrow();

		// Store remains absent after invalid addSchedule attempts
		expect(existsSync(store.schedulesPath)).toBe(false);

		// Maximum 64 schedules enforced; 65th refused with `limit`
		for (let i = 0; i < 64; i += 1) {
			const r = store.addSchedule({
				scheduleId: `sched-${String(i).padStart(2, "0")}`,
				actionKind: "observe-health",
				trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
			});
			expect(r.ok).toBe(true);
		}
		const dup = store.addSchedule({
			scheduleId: "sched-00",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});
		expect(dup.ok).toBe(false);
		if (!dup.ok) expect(dup.code).toBe("duplicate");

		const over = store.addSchedule({
			scheduleId: "sched-64",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.code).toBe("limit");
	});

	it("S1-AT03: deterministic recurrence — interval anchoring, exact boundaries, once completion, IANA TZ & DST transitions", () => {
		const root = makeTempDir("endo-s1-at03-");
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });

		// Interval anchoring + exact due boundary
		const added = store.addSchedule({
			scheduleId: "every-10m",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 600_000, anchorMs: BASE_MS + 600_000 },
		});
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const sched = added.value.schedule;

		// Before anchor -> not-due
		expect(evaluateEndoScheduleDueV0(sched, BASE_MS + 599_999)).toEqual({
			kind: "not-due",
			nextWindowStartMs: BASE_MS + 600_000,
		});
		// Exact boundary -> identical deterministic due-fire across repeated calls
		const evalA = evaluateEndoScheduleDueV0(sched, BASE_MS + 600_000);
		const evalB = evaluateEndoScheduleDueV0(sched, BASE_MS + 600_000);
		expect(evalA).toEqual(evalB);
		expect(evalA).toEqual({
			kind: "due-fire",
			windowStartMs: BASE_MS + 600_000,
			missedWindowsBefore: 0,
			latestMissedBeforeWindowStartMs: null,
			nextWindowStartMs: BASE_MS + 1_200_000,
		});

		// Canonical idempotency key determinism
		const cursor = endoScheduleTriggerCursorV0(sched.trigger);
		const k1 = endoScheduleFireIdempotencyKeyV0({
			scheduleId: sched.scheduleId,
			windowStartMs: BASE_MS + 600_000,
			triggerCursor: cursor,
		});
		const k2 = endoScheduleFireIdempotencyKeyV0({
			scheduleId: sched.scheduleId,
			windowStartMs: BASE_MS + 600_000,
			triggerCursor: cursor,
		});
		expect(k1).toBe(k2);
		expect(k1).toMatch(/^[0-9a-f]{64}$/);

		// DST Spring-Forward in America/New_York: 2026-03-08 02:30 does NOT exist (01:59 EST -> 03:00 EDT)
		expect(resolveEndoLocalWallTimeUtcMsV0("America/New_York", 2026, 3, 8, 2, 30)).toBeNull();
		const nextDay = resolveEndoLocalWallTimeUtcMsV0("America/New_York", 2026, 3, 9, 2, 30);
		expect(nextDay).toBe(Date.parse("2026-03-09T06:30:00Z")); // EDT = UTC-4

		// DST Fall-Back in America/New_York: 2026-11-01 01:30 occurs twice (05:30Z EDT & 06:30Z EST) -> fires ONCE at first occurrence (05:30Z)
		const fallBackFirst = resolveEndoLocalWallTimeUtcMsV0("America/New_York", 2026, 11, 1, 1, 30);
		expect(fallBackFirst).toBe(Date.parse("2026-11-01T05:30:00Z"));
		const fallBackSched = {
			...sched,
			scheduleId: "ny-fallback",
			createdAtMs: Date.parse("2026-10-31T00:00:00Z"),
			updatedAtMs: Date.parse("2026-10-31T00:00:00Z"),
			trigger: {
				kind: "calendar" as const,
				timezone: "America/New_York",
				schedule: { cadence: "daily" as const, hour: 1, minute: 30 },
				dstPolicy: "skip-nonexistent-first-ambiguous" as const,
			},
			cursor: {
				lastEvaluatedAtMs: Date.parse("2026-11-01T05:30:00Z"),
				lastConsumedWindowStartMs: Date.parse("2026-11-01T05:30:00Z"),
				completedOnce: false,
				lastFireIdempotencyKey: null,
				lastFireStatus: "completed" as const,
			},
		};
		// At the second 01:30 (06:30Z EST), must NOT double-fire!
		const secondFold = evaluateEndoScheduleDueV0(fallBackSched, Date.parse("2026-11-01T06:30:00Z"));
		expect(secondFold.kind).toBe("not-due");
	});

	it("S0-AT01: total inference outage resilience — unreachable/503 local endpoints + hosted skipped still produce honest snapshot", async () => {
		const root = makeTempDir("endo-s1-s0at01-");
		// Bind an ephemeral server and close it immediately to get a guaranteed-closed loopback port
		const closedSrv = await startFakeServer((_req, res) => {
			res.statusCode = 500;
			res.end();
		});
		const closedPort = closedSrv.port;
		await closedSrv.close();

		const failingSrv = await startFakeServer((_req, res) => {
			res.statusCode = 503;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ error: { message: "Backend unavailable" } }));
		});

		const pool = makePool([
			{ memberId: "dead-local", endpoint: `http://127.0.0.1:${closedPort}`, modelId: "m-dead", priority: 100 },
			{ memberId: "err-local", endpoint: failingSrv.endpoint, modelId: "m-err", priority: 90 },
			{
				memberId: "hosted-skip",
				kind: "hosted-relay",
				endpoint: "https://openrouter.ai",
				modelId: "openrouter/test",
				priority: 80,
			},
		]);

		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
		expect(
			store.addSchedule({
				scheduleId: "health-outage",
				actionKind: "observe-health",
				trigger: { kind: "once", atMs: BASE_MS + 10_000 },
			}).ok,
		).toBe(true);

		const tick = await runEndoSchedulerTickV0({
			root,
			now: () => BASE_MS + 10_000,
			pool,
			poolSource: "file",
		});

		expect(tick.ok).toBe(true);
		if (!tick.ok) return;
		expect(tick.tokensConsumed).toBe(0);
		expect(tick.publishedResources).toBe(true);
		expect(tick.outcomes).toHaveLength(1);
		expect(tick.outcomes[0]!.status).toBe("completed");

		const resRead = store.readResources();
		expect(resRead.ok && resRead.exists).toBe(true);
		if (!resRead.ok || !resRead.exists) return;
		expect(resRead.value.modelPool.localEndpoints).toHaveLength(2);
		const deadObs = resRead.value.modelPool.localEndpoints.find((e) => e.memberId === "dead-local")!;
		const errObs = resRead.value.modelPool.localEndpoints.find((e) => e.memberId === "err-local")!;
		expect(deadObs.readiness).toBe("unreachable");
		expect(errObs.readiness).toBe("unhealthy");
		// Hosted member was never probed
		expect(resRead.value.modelPool.localEndpoints.some((e) => e.memberId === "hosted-skip")).toBe(false);
		const localProv = resRead.value.providers.find((p) => p.providerId === "local-inference")!;
		expect(localProv.standing).toBe("degraded-endpoint");
	});

	it("S0-AT03 & S1-AT04: concurrent wakeups across two REAL OS processes create one claim and zero duplicate probes", async () => {
		const root = makeTempDir("endo-s1-at04-");
		const srv = await startFakeServer((req, res) => {
			if (req.url === "/health") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ status: "ok" }));
				return;
			}
			if (req.url === "/props") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ role: "router", build_info: "b12622-abcdef1" }));
				return;
			}
			res.statusCode = 404;
			res.end();
		});
		const pool = makePool([{ memberId: "router-1", endpoint: srv.endpoint, modelId: "inkling-2-mini" }]);
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
		expect(
			store.addSchedule({
				scheduleId: "race-health",
				actionKind: "observe-health",
				trigger: { kind: "once", atMs: BASE_MS + 10_000 },
			}).ok,
		).toBe(true);

		const runAt = BASE_MS + 10_000;
		const [w1, w2] = await Promise.all([
			spawnWorker({
				root,
				holderId: "worker-1",
				pool,
				leaseTtlMs: 30_000,
				claimNowMs: runAt,
				publishNowMs: runAt + 50,
			}),
			spawnWorker({
				root,
				holderId: "worker-2",
				pool,
				leaseTtlMs: 30_000,
				claimNowMs: runAt,
				publishNowMs: runAt + 50,
			}),
		]);

		expect(w1.code).toBe(0);
		expect(w2.code).toBe(0);
		const r1 = JSON.parse(w1.stdout.trim()) as { ok: boolean; claimed?: unknown[]; refusal?: string };
		const r2 = JSON.parse(w2.stdout.trim()) as { ok: boolean; claimed?: unknown[]; refusal?: string };

		const totalClaimed = (r1.ok ? (r1.claimed?.length ?? 0) : 0) + (r2.ok ? (r2.claimed?.length ?? 0) : 0);
		expect(totalClaimed).toBe(1);

		// Exactly ONE claim + ONE outcome in fires/
		const fires = store.readFires();
		expect(fires.ok).toBe(true);
		if (fires.ok) {
			expect(fires.entries).toHaveLength(1);
			expect(fires.entries[0]!.state).toBe("completed");
		}
		// Fake server saw ONLY ONE probe pass (/health + /props = 2 requests total, zero duplicate probes)
		expect(srv.hits.map((h) => `${h.method} ${h.url}`)).toEqual(["GET /health", "GET /props"]);
	});

	it("S0-AT04 & S1-AT05: real multi-process lease fencing — expired worker A is refused without overwriting worker B's epoch", async () => {
		const root = makeTempDir("endo-s1-at05-");
		const barrierDir = makeTempDir("endo-s1-barrier-");
		const aClaimed = join(barrierDir, "a-claimed");
		const releaseA = join(barrierDir, "release-a");

		const srv = await startFakeServer((req, res) => {
			if (req.url === "/health") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ status: "ok" }));
				return;
			}
			if (req.url === "/props") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ role: "router", build_info: "b12622-abcdef1" }));
				return;
			}
			res.statusCode = 404;
			res.end();
		});
		const pool = makePool([{ memberId: "router-fence", endpoint: srv.endpoint, modelId: "inkling-2-mini" }]);

		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
		expect(
			store.addSchedule({
				scheduleId: "fence-interval",
				actionKind: "observe-health",
				trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
			}).ok,
		).toBe(true);

		// Start Worker A at T+60s with leaseTtlMs=10s; Worker A pauses before Phase 3 publication until releaseA is written.
		const workerAPromise = spawnWorker({
			root,
			holderId: "worker-A",
			pool,
			leaseTtlMs: 10_000,
			claimNowMs: BASE_MS + 60_000,
			publishNowMs: BASE_MS + 130_000, // after expiry!
			signalClaimedFile: aClaimed,
			waitBeforePublishFile: releaseA,
		});

		// Wait for Worker A to finish Phase 1 claim (epoch 1)
		const deadline = Date.now() + 10_000;
		while (!existsSync(aClaimed)) {
			if (Date.now() > deadline) throw new Error("Worker A did not claim in time");
			await new Promise((r) => setTimeout(r, 20));
		}

		// Worker B wakes at T+120s (after Worker A's 10s lease expired at T+70s) and claims the second window under epoch 2.
		const workerB = await spawnWorker({
			root,
			holderId: "worker-B",
			pool,
			leaseTtlMs: 30_000,
			claimNowMs: BASE_MS + 120_000,
			publishNowMs: BASE_MS + 120_500,
		});
		expect(workerB.code).toBe(0);
		const resB = JSON.parse(workerB.stdout.trim()) as {
			ok: boolean;
			leaseEpoch: number;
			publishedResources: boolean;
		};
		expect(resB.ok).toBe(true);
		expect(resB.leaseEpoch).toBe(2);
		expect(resB.publishedResources).toBe(true);

		// Snapshot resources.json and lease.json written by Worker B
		const resourcesAfterB = readFileSync(store.resourcesPath, "utf8");
		const leaseAfterB = readFileSync(store.leasePath, "utf8");

		// Now unblock Worker A to attempt Phase 3 publication
		writeFileSync(releaseA, "go\n", "utf8");
		const workerA = await workerAPromise;
		expect(workerA.code).toBe(0);
		const resA = JSON.parse(workerA.stdout.trim()) as { ok: boolean; refusal?: string; leaseEpoch?: number };
		expect(resA.ok).toBe(false);
		expect(resA.refusal).toBe("stale-lease-epoch");

		// Worker B's resources.json and lease.json are BYTE-FOR-BYTE UNTOUCHED!
		expect(readFileSync(store.resourcesPath, "utf8")).toBe(resourcesAfterB);
		expect(readFileSync(store.leasePath, "utf8")).toBe(leaseAfterB);

		// Worker A's Phase 1 claim remains visible honestly as `claimed-incomplete`, while Worker B's fire is `completed`.
		const fires = store.readFires();
		expect(fires.ok).toBe(true);
		if (fires.ok) {
			expect(fires.entries).toHaveLength(2);
			expect(fires.entries.some((e) => e.state === "claimed-incomplete" && e.claim?.holderId === "worker-A")).toBe(
				true,
			);
			expect(fires.entries.some((e) => e.state === "completed" && e.outcome?.holderId === "worker-B")).toBe(true);
		}
	});

	it("S0-AT05: missed-run catch-up discipline — 5 missed 30m windows skip cleanly vs coalesce at most once", async () => {
		const root = makeTempDir("endo-s1-s0at05-");
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });

		// Initial tick at BASE_MS establishes lastConsumedWindowStartMs = BASE_MS for both schedules
		expect(
			store.addSchedule({
				scheduleId: "skip-30m",
				actionKind: "observe-health",
				missedRunPolicy: "skip-and-report",
				trigger: { kind: "interval", everyMs: 1_800_000, anchorMs: BASE_MS },
			}).ok,
		).toBe(true);
		expect(
			store.addSchedule({
				scheduleId: "coalesce-30m",
				actionKind: "observe-health",
				missedRunPolicy: "coalesce-once",
				trigger: { kind: "interval", everyMs: 1_800_000, anchorMs: BASE_MS },
			}).ok,
		).toBe(true);

		const firstTick = await runEndoSchedulerTickV0({ root, now: () => BASE_MS });
		expect(firstTick.ok).toBe(true);

		// Host sleeps across 5 windows (+30m, +60m, +90m, +120m, +150m) and wakes at +160m (10m past 5th window)
		let probeCalls = 0;
		const wakeMs = BASE_MS + 5 * 1_800_000 + 600_000;
		const wakeTick = await runEndoSchedulerTickV0({
			root,
			now: () => wakeMs,
			probes: {
				observeProjection: async () => {
					probeCalls += 1;
					return {
						summary: {
							statusSha256: null,
							coordinationSha256: null,
							projectCount: 0,
							activeAssignmentCount: 0,
							unresolvedHazardCount: 0,
							gaps: [],
						},
						sessions: [],
						worktrees: [],
					};
				},
			},
		});

		expect(wakeTick.ok).toBe(true);
		if (!wakeTick.ok) return;
		// skip-30m skipped all 5 missed windows with ZERO catch-up fire
		expect(wakeTick.missedSkipped).toHaveLength(1);
		expect(wakeTick.missedSkipped[0]!.scheduleId).toBe("skip-30m");
		expect(wakeTick.missedSkipped[0]!.missedWindowCount).toBe(5);
		expect(wakeTick.missedSkipped[0]!.status).toBe("missed-skipped");
		// coalesce-30m fired AT MOST ONCE
		expect(wakeTick.claimed).toHaveLength(1);
		expect(wakeTick.claimed[0]!.scheduleId).toBe("coalesce-30m");
		expect(wakeTick.claimed[0]!.missedWindowsBefore).toBe(4);
		expect(probeCalls).toBe(1);
	});

	it("S0-AT06 & S1-AT11: passive llama.cpp observation — zero prohibited routes, honest loading/saturated/unconfirmed states", async () => {
		const root = makeTempDir("endo-s1-at11-");
		const prohibitedHits: FakeServerHit[] = [];
		const checkProhibited = (req: IncomingMessage) => {
			const url = req.url ?? "/";
			const method = req.method ?? "GET";
			if (
				method !== "GET" ||
				url.includes("/slots") ||
				url.includes("/metrics") ||
				url.includes("/chat/completions") ||
				url.includes("/completions") ||
				url.includes("/systemone") ||
				url.includes("?")
			) {
				prohibitedHits.push({ method, url });
			}
		};

		// Router mode server (must NEVER get /models or /v1/models either!)
		const routerSrv = await startFakeServer((req, res) => {
			checkProhibited(req);
			if (req.url === "/models" || req.url === "/v1/models") {
				prohibitedHits.push({ method: req.method ?? "GET", url: `ROUTER:${req.url}` });
			}
			res.setHeader("content-type", "application/json");
			if (req.url === "/health") {
				res.end(JSON.stringify({ status: "ok" }));
				return;
			}
			if (req.url === "/props") {
				res.end(JSON.stringify({ role: "router", build_info: "b12622-0123456" }));
				return;
			}
			res.statusCode = 404;
			res.end();
		});

		// Single llama.cpp server awake
		const singleSrv = await startFakeServer((req, res) => {
			checkProhibited(req);
			res.setHeader("content-type", "application/json");
			if (req.url === "/health") {
				res.end(JSON.stringify({ status: "ok" }));
				return;
			}
			if (req.url === "/props") {
				res.end(JSON.stringify({ build_info: "b12622-0123456", total_slots: 4, is_sleeping: false }));
				return;
			}
			if (req.url === "/models") {
				res.end(JSON.stringify({ data: [{ id: "inkling-single" }] }));
				return;
			}
			res.statusCode = 404;
			res.end();
		});

		// Loading server (503 Loading model)
		const loadingSrv = await startFakeServer((req, res) => {
			checkProhibited(req);
			res.setHeader("content-type", "application/json");
			res.statusCode = 503;
			res.end(JSON.stringify({ error: { message: "Loading model" } }));
		});

		const pool = makePool([
			{ memberId: "router-mem", endpoint: routerSrv.endpoint, modelId: "inkling-router", priority: 100 },
			{ memberId: "single-mem", endpoint: singleSrv.endpoint, modelId: "inkling-single", priority: 90 },
			{ memberId: "loading-mem", endpoint: loadingSrv.endpoint, modelId: "inkling-loading", priority: 80 },
		]);

		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
		expect(
			store.addSchedule({
				scheduleId: "passive-llama",
				actionKind: "observe-health",
				trigger: { kind: "once", atMs: BASE_MS + 10_000 },
			}).ok,
		).toBe(true);

		const tick = await runEndoSchedulerTickV0({
			root,
			now: () => BASE_MS + 10_000,
			pool,
			poolSource: "file",
			deviceAttribution: new Map([
				["router-mem", "gpu-0"],
				["single-mem", "gpu-0"],
			]),
		});
		expect(tick.ok).toBe(true);
		expect(prohibitedHits).toEqual([]);

		const resRead = store.readResources();
		expect(resRead.ok && resRead.exists).toBe(true);
		if (!resRead.ok || !resRead.exists) return;
		const eps = resRead.value.modelPool.localEndpoints;
		expect(eps.find((e) => e.memberId === "router-mem")!.readiness).toBe("model-unconfirmed");
		expect(eps.find((e) => e.memberId === "single-mem")!.readiness).toBe("capacity-unknown");
		expect(eps.find((e) => e.memberId === "loading-mem")!.readiness).toBe("loading");
		expect(resRead.value.providers.find((p) => p.providerId === "local-inference")!.standing).toBe(
			"degraded-endpoint",
		);

		// Shared GPU contention tracked honestly when 2 members map to gpu-0
		const gpu = resRead.value.hardware.devices.find((d) => d.deviceId === "gpu-0");
		expect(gpu).toBeDefined();
		expect(gpu!.sharedDeviceContention).toBe("shared-multiple-members");
		expect(gpu!.attributedModelMemberIds).toEqual(["router-mem", "single-mem"]);

		// Also verify healthy router + single WITHOUT loading server stays `unknown` (never `available`!), and injected `saturated` -> `degraded-endpoint`
		const root2 = makeTempDir("endo-s1-at11-sat-");
		const store2 = new DevelopAutomationStoreV0(root2, { now: () => BASE_MS });
		store2.addSchedule({
			scheduleId: "healthy-only",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});
		const healthyPool = makePool([
			{ memberId: "single-only", endpoint: singleSrv.endpoint, modelId: "inkling-single" },
		]);
		await runEndoSchedulerTickV0({ root: root2, now: () => BASE_MS + 60_000, pool: healthyPool, poolSource: "file" });
		const r2 = store2.readResources();
		expect(r2.ok && r2.exists).toBe(true);
		if (r2.ok && r2.exists) {
			expect(r2.value.providers.find((p) => p.providerId === "local-inference")!.standing).toBe("unknown");
		}
		// Injected passive saturation observer -> `degraded-endpoint`
		await runEndoSchedulerTickV0({
			root: root2,
			now: () => BASE_MS + 120_000,
			pool: healthyPool,
			poolSource: "file",
			probes: {
				observeLocalMember: async (m) =>
					Object.freeze({
						memberId: m.memberId,
						endpoint: m.endpoint,
						modelId: m.modelId,
						basis: "controller-observed",
						observedAtMs: BASE_MS + 120_000,
						elapsedMs: 1,
						readiness: "saturated",
						detail: "no-idle-slot",
						backend: "llama.cpp-single",
						build: "b12622-0123456",
						requests: Object.freeze([]),
						inferenceTokens: 0,
					}),
			},
		});
		const r2Sat = store2.readResources();
		expect(r2Sat.ok && r2Sat.exists).toBe(true);
		if (r2Sat.ok && r2Sat.exists) {
			expect(r2Sat.value.providers.find((p) => p.providerId === "local-inference")!.standing).toBe(
				"degraded-endpoint",
			);
		}
	});

	it("S0-AT08, S1-AT12, S1-AT13: subscription uncertainty, separate windows, shared quota pools, stale/expired degradation", async () => {
		const root = makeTempDir("endo-s1-at12-");
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });

		// Declare two distinct windows for Claude Code + another provider sharing the same quota pool
		expect(
			store.declareResourceWindow({
				providerId: "claude-code-subscription",
				surfaceKind: "subscription-window",
				quotaPoolId: "anthropic-consumer-shared",
				windowKind: "rolling-5h",
				standing: "exhausted-until-reset",
				resetAtMs: BASE_MS + 3_600_000,
			}).ok,
		).toBe(true);
		expect(
			store.declareResourceWindow({
				providerId: "claude-code-subscription",
				surfaceKind: "subscription-window",
				quotaPoolId: "anthropic-consumer-shared",
				windowKind: "weekly",
				standing: "approaching-limit",
				resetAtMs: BASE_MS + 5 * 86_400_000,
			}).ok,
		).toBe(true);
		expect(
			store.declareResourceWindow({
				providerId: "claude-web",
				surfaceKind: "subscription-window",
				quotaPoolId: "anthropic-consumer-shared",
				windowKind: "rolling-5h",
				standing: "unknown",
				resetAtMs: BASE_MS + 3_600_000,
			}).ok,
		).toBe(true);

		store.addSchedule({
			scheduleId: "sub-obs",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});

		// Tick before resetAtMs with local turn ledger lower bound for codex-subscription (no declaration)
		const tick1 = await runEndoSchedulerTickV0({
			root,
			now: () => BASE_MS + 60_000,
			staleAfterMs: 300_000,
			probes: {
				observeLocalTurnLedger: () =>
					new Map([
						["codex-subscription", 14],
						["claude-code-subscription", 7],
					]),
			},
		});
		expect(tick1.ok).toBe(true);

		const res1 = store.readResources();
		expect(res1.ok && res1.exists).toBe(true);
		if (!res1.ok || !res1.exists) return;

		// Codex with no API and no declaration stays `unknown` with explicit local lower bound
		const codex = res1.value.providers.find((p) => p.providerId === "codex-subscription")!;
		expect(codex.standing).toBe("unknown");
		expect(codex.basis).toBe("controller-ledger-estimate");
		expect(codex.localLedgerLowerBound).toEqual({
			recordedTurns: 14,
			recordedAtMs: BASE_MS + 60_000,
			note: "local-endophasia-lower-bound-only",
		});

		// Claude has 2 separate windows (rolling-5h + weekly) and shared quotaPoolId
		const claude = res1.value.providers.find((p) => p.providerId === "claude-code-subscription")!;
		expect(claude.quotaPoolId).toBe("anthropic-consumer-shared");
		expect(claude.windows.map((w) => w.windowKind).sort()).toEqual(["rolling-5h", "weekly"]);
		expect(claude.windows.every((w) => w.availabilityConfirmed === false)).toBe(true);
		expect(claude.standing).toBe("exhausted-until-reset");

		// Fresh evaluation BEFORE reset -> exhausted-until-reset
		const effFresh = endoEffectiveProviderAllowanceV0(claude, BASE_MS + 120_000);
		expect(effFresh.freshness).toBe("fresh");
		expect(effFresh.effectiveStanding).toBe("exhausted-until-reset");
		expect(effFresh.availabilityConfirmed).toBe(false);

		// Evaluation AFTER resetAtMs -> MUST NOT become `available`; becomes `unknown` with resetPassedUnverified=true!
		const effAfterReset = endoEffectiveProviderAllowanceV0(
			{ ...claude, staleAfterMs: 10_000_000 },
			BASE_MS + 3_600_000 + 1_000,
		);
		expect(effAfterReset.effectiveStanding).toBe("unknown");
		expect(effAfterReset.availabilityConfirmed).toBe(false);
		expect(effAfterReset.resetPassedUnverified).toBe(true);

		// Stale observation degrades even an authoritative `available` standing to `unknown`
		const staleEff = endoEffectiveProviderAllowanceV0(
			{
				providerId: "openrouter",
				surfaceKind: "api-rate-limit",
				quotaPoolId: null,
				standing: "available",
				basis: "authoritative-api",
				observedAtMs: BASE_MS,
				staleAfterMs: 60_000,
				windows: [],
				localLedgerLowerBound: null,
				detail: null,
			},
			BASE_MS + 61_000,
		);
		expect(staleEff.freshness).toBe("stale");
		expect(staleEff.effectiveStanding).toBe("unknown");
		expect(staleEff.availabilityConfirmed).toBe(false);
	});

	it("S1-AT06: crash after claim leaves `claimed-incomplete`, never deleted, overwritten, fabricated, or replayed", async () => {
		const root = makeTempDir("endo-s1-at06-");
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
		store.addSchedule({
			scheduleId: "crash-claim",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});

		// Simulate crash immediately after Phase 1 writes `.claimed.json`
		await expect(
			runEndoSchedulerTickV0({
				root,
				now: () => BASE_MS + 60_000,
				leaseTtlMs: 10_000,
				hooks: {
					afterPhase1Claim: () => {
						throw new Error("SIMULATED_SIGKILL_AFTER_CLAIM");
					},
				},
			}),
		).rejects.toThrow("SIMULATED_SIGKILL_AFTER_CLAIM");

		const proj1 = readEndoAutomationProjectionV0(root, { now: () => BASE_MS + 65_000 });
		expect(proj1.fires.state).toBe("ready");
		if (proj1.fires.state === "ready") {
			expect(proj1.fires.incompleteCount).toBe(1);
			expect(proj1.fires.entries[0]!.state).toBe("claimed-incomplete");
		}
		const incompleteKey = proj1.fires.state === "ready" ? proj1.fires.entries[0]!.idempotencyKey : "";

		// Subsequent tick after lease expires (still within window 1, before window 2 at +120s):
		// MUST NOT replay window 1 and MUST leave incomplete claim intact!
		const tick2 = await runEndoSchedulerTickV0({
			root,
			now: () => BASE_MS + 80_000,
			leaseTtlMs: 10_000,
		});
		expect(tick2.ok).toBe(true);
		if (tick2.ok) {
			expect(tick2.leaseEpoch).toBe(2);
			expect(tick2.claimed).toHaveLength(0);
		}
		const claimStillThere = store.readFireClaim(incompleteKey);
		const outcomeStillAbsent = store.readFireOutcome(incompleteKey);
		expect(claimStillThere.ok && claimStillThere.exists).toBe(true);
		expect(outcomeStillAbsent.ok && !outcomeStillAbsent.exists).toBe(true);
	});

	it("S1-AT07: publication crash boundaries remain inspectable and honestly classified", async () => {
		// 1. Failure BEFORE resources.json publication -> resources absent, claim stays `claimed-incomplete`
		const rootA = makeTempDir("endo-s1-at07a-");
		new DevelopAutomationStoreV0(rootA, { now: () => BASE_MS }).addSchedule({
			scheduleId: "c1",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		await expect(
			runEndoSchedulerTickV0({
				root: rootA,
				now: () => BASE_MS + 10_000,
				hooks: {
					beforePublishResources: () => {
						throw new Error("CRASH_BEFORE_RESOURCES");
					},
				},
			}),
		).rejects.toThrow("CRASH_BEFORE_RESOURCES");
		const pA = readEndoAutomationProjectionV0(rootA, { now: () => BASE_MS + 10_000 });
		expect(pA.resources.state).toBe("absent");
		expect(pA.fires.state === "ready" && pA.fires.incompleteCount === 1).toBe(true);

		// 2. Failure AFTER resources.json publication, BEFORE outcome write -> resources ready, claim stays `claimed-incomplete`
		const rootB = makeTempDir("endo-s1-at07b-");
		new DevelopAutomationStoreV0(rootB, { now: () => BASE_MS }).addSchedule({
			scheduleId: "c2",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		await expect(
			runEndoSchedulerTickV0({
				root: rootB,
				now: () => BASE_MS + 10_000,
				hooks: {
					beforeWriteOutcome: () => {
						throw new Error("CRASH_BEFORE_OUTCOME");
					},
				},
			}),
		).rejects.toThrow("CRASH_BEFORE_OUTCOME");
		const pB = readEndoAutomationProjectionV0(rootB, { now: () => BASE_MS + 10_000 });
		expect(pB.resources.state).toBe("ready");
		expect(pB.fires.state === "ready" && pB.fires.incompleteCount === 1).toBe(true);

		// 3. Failure AFTER outcome write, BEFORE lease release -> resources ready, outcome completed, lease held until expiry
		const rootC = makeTempDir("endo-s1-at07c-");
		new DevelopAutomationStoreV0(rootC, { now: () => BASE_MS }).addSchedule({
			scheduleId: "c3",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		await expect(
			runEndoSchedulerTickV0({
				root: rootC,
				now: () => BASE_MS + 10_000,
				leaseTtlMs: 10_000,
				hooks: {
					beforeReleaseLease: () => {
						throw new Error("CRASH_BEFORE_LEASE_RELEASE");
					},
				},
			}),
		).rejects.toThrow("CRASH_BEFORE_LEASE_RELEASE");
		const pC = readEndoAutomationProjectionV0(rootC, { now: () => BASE_MS + 15_000 });
		expect(pC.resources.state).toBe("ready");
		expect(pC.fires.state === "ready" && pC.fires.entries[0]!.state === "completed").toBe(true);
		expect(pC.lease.state === "ready" && pC.lease.active).toBe(true);
		// After expiry, a subsequent tick cleanly advances epoch
		const recoverC = await runEndoSchedulerTickV0({ root: rootC, now: () => BASE_MS + 25_000, leaseTtlMs: 10_000 });
		expect(recoverC.ok && recoverC.leaseEpoch === 2).toBe(true);

		// 4. Failure AFTER atomic rename (dir fsync fails) -> `commit-uncertain`
		const rootD = makeTempDir("endo-s1-at07d-");
		const storeD = new DevelopAutomationStoreV0(rootD, {
			now: () => BASE_MS,
			afterReplace: (name) => {
				if (name === "schedules.json") throw new Error("FSYNC_DIR_FAIL");
			},
		});
		const addD = storeD.addSchedule({
			scheduleId: "c4",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		expect(addD.ok).toBe(false);
		if (!addD.ok) expect(addD.code).toBe("commit-uncertain");
	});

	it("S1-AT08: schedule revision races — disable, remove, and revise in flight do not misattribute or resurrect", async () => {
		const root = makeTempDir("endo-s1-at08-");
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });

		store.addSchedule({
			scheduleId: "to-disable",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		store.addSchedule({
			scheduleId: "to-remove",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		store.addSchedule({
			scheduleId: "to-revise",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});

		const tick = await runEndoSchedulerTickV0({
			root,
			now: () => BASE_MS + 10_000,
			hooks: {
				beforePhase2Probes: () => {
					expect(store.setScheduleEnabled("to-disable", false, 1).ok).toBe(true);
					expect(store.removeSchedule("to-remove", 1).ok).toBe(true);
					expect(store.reviseSchedule({ scheduleId: "to-revise", expectedRevision: 1, label: "updated" }).ok).toBe(
						true,
					);
				},
			},
		});

		expect(tick.ok).toBe(true);
		if (!tick.ok) return;
		// None of the 3 claimed schedules remained valid -> resources.json was NOT published
		expect(tick.publishedResources).toBe(false);
		expect(tick.outcomes).toHaveLength(3);
		for (const o of tick.outcomes) {
			expect(o.status).toBe("cancelled-schedule-changed");
			expect(o.scheduleRevision).toBe(1);
			expect(o.observationDigest).toBeNull();
			expect(o.tokensConsumed).toBe(0);
		}
		expect(tick.outcomes.find((o) => o.scheduleId === "to-disable")!.detail).toContain("schedule-disabled-in-flight");
		expect(tick.outcomes.find((o) => o.scheduleId === "to-remove")!.detail).toContain("schedule-removed-in-flight");
		expect(tick.outcomes.find((o) => o.scheduleId === "to-revise")!.detail).toContain("schedule-revised-in-flight");

		// Post-tick schedules.json preserved operator's mutations (no resurrection, no overwrite)
		const after = store.readSchedules();
		expect(after.ok && after.exists).toBe(true);
		if (after.ok && after.exists) {
			expect(after.value.schedules.find((s) => s.scheduleId === "to-disable")!.enabled).toBe(false);
			expect(after.value.schedules.find((s) => s.scheduleId === "to-remove")).toBeUndefined();
			expect(after.value.schedules.find((s) => s.scheduleId === "to-revise")!.revision).toBe(2);
			expect(after.value.schedules.find((s) => s.scheduleId === "to-revise")!.label).toBe("updated");
		}
	});

	it("S1-AT09: clock discontinuities — backward jump prevents replay & publication, exact expiry refuses, 10-year jump is O(1)", async () => {
		const root = makeTempDir("endo-s1-at09-");
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
		store.addSchedule({
			scheduleId: "clock-int",
			actionKind: "observe-health",
			missedRunPolicy: "skip-and-report",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});

		// Normal tick at +60s
		const t1 = await runEndoSchedulerTickV0({ root, now: () => BASE_MS + 60_000 });
		expect(t1.ok && t1.claimed.length === 1).toBe(true);

		// Backward wall-clock jump to BASE_MS -> clock-behind-cursor, zero replay!
		const tBack = await runEndoSchedulerTickV0({ root, now: () => BASE_MS });
		expect(tBack.ok).toBe(true);
		if (tBack.ok) {
			expect(tBack.claimed).toHaveLength(0);
			expect(tBack.missedSkipped).toHaveLength(0);
		}

		// Mid-tick backward clock jump (Phase 3 publishNowMs < Phase 1 claimNowMs) -> refused with stale-lease-epoch!
		let clockVal = BASE_MS + 120_000;
		const tMidBack = await runEndoSchedulerTickV0({
			root,
			now: () => clockVal,
			leaseTtlMs: 30_000,
			hooks: {
				afterPhase2Probes: () => {
					clockVal = BASE_MS + 110_000; // jumped 10s backward before publication!
				},
			},
		});
		expect(tMidBack.ok).toBe(false);
		if (!tMidBack.ok) expect(tMidBack.refusal).toBe("stale-lease-epoch");

		// Exact lease-expiry boundary (`publishNowMs === expiresAtMs`) refuses publication!
		let expClock = BASE_MS + 180_000;
		const tExactExp = await runEndoSchedulerTickV0({
			root,
			now: () => expClock,
			leaseTtlMs: 10_000,
			hooks: {
				afterPhase2Probes: () => {
					expClock = BASE_MS + 190_000; // exact expiresAtMs!
				},
			},
		});
		expect(tExactExp.ok).toBe(false);
		if (!tExactExp.ok) expect(tExactExp.refusal).toBe("stale-lease-epoch");

		// 10-year forward jump completes in O(1) ms without looping through 5,256,000 missed windows!
		const tenYearsLater = BASE_MS + 10 * 365 * 86_400_000 + 30_000;
		const started = performance.now();
		const tTenYears = await runEndoSchedulerTickV0({ root, now: () => tenYearsLater });
		const elapsed = performance.now() - started;
		expect(tTenYears.ok).toBe(true);
		expect(elapsed).toBeLessThan(2_000);
		if (tTenYears.ok) {
			expect(tTenYears.claimed).toHaveLength(0);
			expect(tTenYears.missedSkipped).toHaveLength(1);
			expect(tTenYears.missedSkipped[0]!.missedWindowCount).toBeGreaterThan(5_000_000);
		}
	});

	it("S1-AT10: retention safety — pruning keeps unresolved claims and never resurrects pruned windows (even across remove+readd)", async () => {
		const root = makeTempDir("endo-s1-at10-");
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });

		store.addSchedule({
			scheduleId: "ret-int",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});
		store.addSchedule({
			scheduleId: "ret-incomplete",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 60_000 },
		});

		// Create 1 `claimed-incomplete` fire on `ret-incomplete` (crashes after Phase 1)
		await expect(
			runEndoSchedulerTickV0({
				root,
				now: () => BASE_MS + 60_000,
				leaseTtlMs: 5_000,
				hooks: {
					afterPhase1Claim: () => {
						throw new Error("CRASH_FOR_INCOMPLETE");
					},
				},
			}),
		).rejects.toThrow("CRASH_FOR_INCOMPLETE");

		// Run 6 completed ticks on `ret-int` with retention cap = 2 terminal pairs
		for (let i = 2; i <= 7; i += 1) {
			const res = await runEndoSchedulerTickV0({
				root,
				now: () => BASE_MS + i * 60_000,
				leaseTtlMs: 5_000,
				maxFirePairsRetained: 2,
			});
			expect(res.ok).toBe(true);
		}

		// Verify: 2 newest terminal fires remain + ALL unresolved `claimed-incomplete` fires were preserved!
		const fires = store.readFires();
		expect(fires.ok).toBe(true);
		if (fires.ok) {
			const incomplete = fires.entries.filter((e) => e.state === "claimed-incomplete");
			const completed = fires.entries.filter((e) => e.state === "completed");
			expect(incomplete.length).toBeGreaterThanOrEqual(1);
			expect(completed).toHaveLength(2);
		}

		// Re-evaluating at an older pruned window (i = 2 -> +120s) MUST NOT resurrect it!
		const oldWindowTick = await runEndoSchedulerTickV0({
			root,
			now: () => BASE_MS + 2 * 60_000,
			leaseTtlMs: 5_000,
		});
		expect(oldWindowTick.ok && oldWindowTick.claimed.length === 0).toBe(true);

		// Remove `ret-int` and re-add with the same scheduleId & anchor -> inherits retired cursor floor!
		expect(store.removeSchedule("ret-int").ok).toBe(true);
		const readded = store.addSchedule({
			scheduleId: "ret-int",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});
		expect(readded.ok).toBe(true);
		if (readded.ok) {
			expect(readded.value.schedule.cursor.lastConsumedWindowStartMs).toBe(BASE_MS + 7 * 60_000);
		}
		const afterReaddTick = await runEndoSchedulerTickV0({
			root,
			now: () => BASE_MS + 7 * 60_000,
			leaseTtlMs: 5_000,
		});
		expect(afterReaddTick.ok && afterReaddTick.claimed.length === 0).toBe(true);
	});

	it("S1-AT14: bounded operation — hanging endpoint, oversized response, and corrupt stores fail closed", async () => {
		const root = makeTempDir("endo-s1-at14-");
		// Hanging server (never responds until closed)
		const hangSrv = await startFakeServer((_req, _res) => {
			// intentionally never respond
		});
		// Oversized server (> 256 KiB)
		const bigSrv = await startFakeServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end("x".repeat(300 * 1024));
		});
		const pool = makePool([
			{ memberId: "hang-ep", endpoint: hangSrv.endpoint, modelId: "m-hang", priority: 100 },
			{ memberId: "big-ep", endpoint: bigSrv.endpoint, modelId: "m-big", priority: 90 },
		]);

		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
		store.addSchedule({
			scheduleId: "bound-check",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});

		const tick = await runEndoSchedulerTickV0({
			root,
			now: () => BASE_MS + 10_000,
			pool,
			poolSource: "file",
			tickBudgetMs: 400,
		});
		expect(tick.ok).toBe(true);
		const resRead = store.readResources();
		expect(resRead.ok && resRead.exists).toBe(true);
		if (resRead.ok && resRead.exists) {
			const hangObs = resRead.value.modelPool.localEndpoints.find((e) => e.memberId === "hang-ep")!;
			const bigObs = resRead.value.modelPool.localEndpoints.find((e) => e.memberId === "big-ep")!;
			expect(hangObs.readiness).toBe("unreachable");
			expect(bigObs.readiness).toBe("probe-refused");
		}

		// Corrupt schedules.json fails closed and is NOT overwritten
		const corruptBytes = "{ not valid json !!!\n";
		writeFileSync(store.schedulesPath, corruptBytes, "utf8");
		const corruptTick = await runEndoSchedulerTickV0({ root, now: () => BASE_MS + 20_000 });
		expect(corruptTick.ok).toBe(false);
		if (!corruptTick.ok) expect(corruptTick.refusal).toBe("unreadable");
		expect(readFileSync(store.schedulesPath, "utf8")).toBe(corruptBytes);
	});

	it("S1-AT15: filesystem safety — symlinks, FIFOs, duplicate JSON keys, unsafe identifiers refused", () => {
		const root = makeTempDir("endo-s1-at15-");
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
		mkdirSync(store.dir, { recursive: true });

		// Duplicate JSON keys rejected
		writeFileSync(
			store.schedulesPath,
			'{"schemaVersion":"endo.develop-schedules.v0","revision":1,"revision":2,"updatedAtMs":1,"schedules":[],"retiredCursors":[]}\n',
			"utf8",
		);
		const dupRead = store.readSchedules();
		expect(dupRead.ok).toBe(false);
		if (!dupRead.ok) expect(dupRead.reason).toBe("duplicate-key");

		// Symlinked schedules.json rejected
		rmSync(store.schedulesPath, { force: true });
		const outside = join(makeTempDir("endo-s1-outside-"), "real.json");
		writeFileSync(
			outside,
			'{"schemaVersion":"endo.develop-schedules.v0","revision":0,"updatedAtMs":0,"schedules":[],"retiredCursors":[]}\n',
			"utf8",
		);
		symlinkSync(outside, store.schedulesPath);
		const symRead = store.readSchedules();
		expect(symRead.ok).toBe(false);
		if (!symRead.ok) expect(symRead.reason).toBe("unsafe-path");

		// Symlinked automation directory rejected
		const symRoot = makeTempDir("endo-s1-symdir-");
		mkdirSync(join(symRoot, "develop"), { recursive: true });
		symlinkSync(store.dir, join(symRoot, "develop", "automation"));
		const symStore = new DevelopAutomationStoreV0(symRoot);
		const symDirRead = symStore.readSchedules();
		expect(symDirRead.ok).toBe(false);
		if (!symDirRead.ok) expect(symDirRead.reason).toBe("unsafe-path");

		// Unsafe idempotencyKey refused before path join
		const badFire = store.readFireClaim("../escape");
		expect(badFire.ok).toBe(false);
		if (!badFire.ok) expect(badFire.reason).toBe("unsafe-path");

		// FIFO in place of lease.json rejected immediately without hanging (O_NONBLOCK + isFile check)
		const fifoRoot = makeTempDir("endo-s1-fifo-");
		const fifoStore = new DevelopAutomationStoreV0(fifoRoot);
		mkdirSync(fifoStore.dir, { recursive: true });
		const mkfifo = spawnSync("mkfifo", [fifoStore.leasePath]);
		if (mkfifo.status === 0) {
			const fifoRead = fifoStore.readLease();
			expect(fifoRead.ok).toBe(false);
			if (!fifoRead.ok) expect(fifoRead.reason).toBe("unsafe-path");
		}
	});

	it("S0-AT11 & S1-AT16: existing lock non-interference — holding real pre-E4 session-attachment.lock does not block tick or event writing", async () => {
		const root = makeTempDir("endo-s1-at16-");
		// Acquire the ACTUAL pre-E4 event-store writer lock!
		const releaseWriterLock = acquireEndoEventStoreWriterLockV0(root, "pi.live-session");
		try {
			const lockPath = join(root, "events", "session-attachment.lock");
			expect(existsSync(lockPath)).toBe(true);
			const lockBefore = readFileSync(lockPath, "utf8");

			// Open durable event store and ingest an event while lock is held
			const evStore = createEndoDurableEventStoreV0(root);
			try {
				evStore.ingest({
					schemaVersion: "endo.event.v0",
					id: "endo.event.11111111111111111111111111111111",
					at: new Date(BASE_MS).toISOString(),
					sequence: 1,
					kind: "turn.started",
					source: "runtime-fact",
					producer: "pi.default",
					coordinates: { sessionId: "endo.session.codex.test1" },
					payload: { instanceId: "inst-1" },
					derivedFrom: [],
				});

				// Schedule & run S1 tick (both observe-health and refresh-projection) WHILE session-attachment.lock is held!
				const autoStore = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
				autoStore.addSchedule({
					scheduleId: "non-interfere-health",
					actionKind: "observe-health",
					trigger: { kind: "once", atMs: BASE_MS + 1_000 },
				});
				autoStore.addSchedule({
					scheduleId: "non-interfere-proj",
					actionKind: "refresh-projection",
					trigger: { kind: "once", atMs: BASE_MS + 1_000 },
				});

				const tick = await runEndoSchedulerTickV0({ root, now: () => BASE_MS + 1_000 });
				expect(tick.ok).toBe(true);
				if (tick.ok) {
					expect(tick.claimed).toHaveLength(2);
					expect(tick.publishedResources).toBe(true);
				}

				// Event-store writer lock is byte-for-byte untouched and still held by pi.live-session!
				expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);

				// Live event writer continues ingesting without contention
				evStore.ingest({
					schemaVersion: "endo.event.v0",
					id: "endo.event.22222222222222222222222222222222",
					at: new Date(BASE_MS + 2_000).toISOString(),
					sequence: 2,
					kind: "turn.started",
					source: "runtime-fact",
					producer: "pi.default",
					coordinates: { sessionId: "endo.session.codex.test1" },
					payload: { instanceId: "inst-1" },
					derivedFrom: [],
				});
				expect(evStore.length).toBe(2);

				// Neither tasks.lock.* nor coordination.lock.* was created
				const devEntries = readdirSync(join(root, "develop"));
				expect(devEntries.some((n) => n.startsWith("tasks.lock") || n.startsWith("coordination.lock"))).toBe(false);
			} finally {
				evStore.close();
			}
		} finally {
			releaseWriterLock();
		}
	});

	it("S1-AT17 & S1-AT18: governance preservation & zero inference — ticks never mutate tasks/coordination/routes/worktree or call completions", async () => {
		const root = makeTempDir("endo-s1-at17-store-");
		const repo = makeTempDir("endo-s1-at17-repo-");
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
		writeFileSync(join(repo, "file.txt"), "hello\n", "utf8");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

		// Populate real DEVELOP project, task, and coordination assignment
		const tasksStore = new DevelopTasksStoreV0(root);
		const addedProj = tasksStore.registerProject({
			name: "s1-gov",
			path: repo,
			observedGitRoot: repo,
		});
		expect(addedProj.ok).toBe(true);
		if (!addedProj.ok) return;
		const projId = addedProj.value.id;
		const addedTask = tasksStore.createTask(projId, {
			title: "Governed task",
		});
		expect(addedTask.ok).toBe(true);
		if (!addedTask.ok) return;

		const coordStore = new DevelopCoordinationStoreV0(root, { now: () => BASE_MS });
		const createdAssign = coordStore.createAssignment({
			expectedFileRevision: 0,
			expectedTaskRevision: addedTask.value.revision,
			projectId: projId,
			taskId: addedTask.value.id,
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
		expect(createdAssign.ok).toBe(true);

		const tasksBefore = readFileSync(tasksStore.path, "utf8");
		const coordBefore = readFileSync(coordStore.path, "utf8");
		const repoBefore = fingerprintTree(repo);

		let completionCalls = 0;
		const srv = await startFakeServer((req, res) => {
			if (req.method === "POST" || (req.url ?? "").includes("completion") || (req.url ?? "").includes("systemone")) {
				completionCalls += 1;
			}
			res.setHeader("content-type", "application/json");
			if (req.url === "/health") res.end(JSON.stringify({ status: "ok" }));
			else if (req.url === "/props") res.end(JSON.stringify({ role: "router", build_info: "b12622-abcdef1" }));
			else {
				res.statusCode = 404;
				res.end();
			}
		});
		const pool = makePool([{ memberId: "local-1", endpoint: srv.endpoint, modelId: "inkling-2-mini" }]);

		const autoStore = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });
		autoStore.addSchedule({
			scheduleId: "gov-health",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 5_000 },
		});
		autoStore.addSchedule({
			scheduleId: "gov-proj",
			actionKind: "refresh-projection",
			trigger: { kind: "once", atMs: BASE_MS + 5_000 },
		});

		const tick = await runEndoSchedulerTickV0({ root, now: () => BASE_MS + 5_000, pool, poolSource: "file" });
		expect(tick.ok).toBe(true);
		if (tick.ok) {
			expect(tick.tokensConsumed).toBe(0);
			expect(tick.outcomes.every((o) => o.tokensConsumed === 0)).toBe(true);
		}
		expect(completionCalls).toBe(0);

		// Governance invariants: tasks.json, coordination.json, worktree untouched; zero routes/authorizations/attempts created!
		expect(readFileSync(tasksStore.path, "utf8")).toBe(tasksBefore);
		expect(readFileSync(coordStore.path, "utf8")).toBe(coordBefore);
		expect(fingerprintTree(repo)).toEqual(repoBefore);
		expect(existsSync(join(root, "develop", "attempt-routes"))).toBe(false);
		expect(existsSync(join(root, "develop", "adapter-authorizations"))).toBe(false);
		expect(existsSync(join(root, "develop", "attempts"))).toBe(false);
		expect(existsSync(join(root, "develop", "receipts"))).toBe(false);
	});

	it("S1-AT19: systemd template safety — valid syntax, escaping of spaces/$/%, bounded limits, zero installation", () => {
		const home = makeTempDir("endo-s1-at19-home-");
		const env = { HOME: home, XDG_CONFIG_HOME: join(home, "xdg-config") };
		const weirdRoot = join(home, "store with spaces & $HOME %i");

		// Escaping unit check
		expect(escapeEndoSystemdExecArgV0("/tmp/a b/$HOME/%n")).toBe('"/tmp/a b/$$HOME/%%n"');
		expect(() => escapeEndoSystemdExecArgV0("/tmp/bad\nline")).toThrow(/control characters/);

		// Direct renderer check
		const rendered = renderEndoSystemdUnitsV0({
			endoBin: "/usr/local/bin/endo",
			storeRoot: weirdRoot,
			poolPath: "/etc/endo/pool.json",
		});
		expect(rendered.installed).toBe(false);
		expect(rendered.activated).toBe(false);
		expect(rendered.serviceContent).toContain("[Unit]");
		expect(rendered.serviceContent).toContain("[Service]");
		expect(rendered.serviceContent).toContain("Type=oneshot");
		expect(rendered.serviceContent).toContain("TimeoutStartSec=90s");
		expect(rendered.serviceContent).toContain("NoNewPrivileges=yes");
		expect(rendered.serviceContent).toContain("MemoryMax=512M");
		expect(rendered.serviceContent).toContain("$$HOME");
		expect(rendered.serviceContent).toContain("%%i");
		expect(rendered.timerContent).toContain("[Timer]");
		expect(rendered.timerContent).toContain("OnCalendar=*:0/5");
		expect(rendered.timerContent).toContain("Persistent=true");
		expect(rendered.timerContent).toContain("RandomizedDelaySec=15s");
		expect(rendered.timerContent).toContain("AccuracySec=30s");
		expect(rendered.timerContent).toContain("[Install]");

		// CLI print-systemd-unit (text and --json) writes nothing to ~/.config/systemd/user
		const cliRes = runCli(
			["scheduler", "print-systemd-unit", "--root", weirdRoot, "--endo-bin", "/usr/local/bin/endo", "--json"],
			env,
		);
		expect(cliRes.status).toBe(0);
		const parsed = JSON.parse(cliRes.stdout) as { systemdUnits: { installed: boolean; activated: boolean } };
		expect(parsed.systemdUnits.installed).toBe(false);
		expect(parsed.systemdUnits.activated).toBe(false);
		expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
		expect(existsSync(join(home, "xdg-config", "systemd"))).toBe(false);
		expect(existsSync(weirdRoot)).toBe(false);
	});

	it("S1-AT20 + S2 Seam + CLI end-to-end: CLI schedule/scheduler/resource workflow and M1 recorded-observation handoff", async () => {
		const root = makeTempDir("endo-s1-cli-");
		const srv = await startFakeServer((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/health") res.end(JSON.stringify({ status: "ok" }));
			else if (req.url === "/props")
				res.end(JSON.stringify({ build_info: "b12622-abcdef1", total_slots: 2, is_sleeping: false }));
			else if (req.url === "/models") res.end(JSON.stringify({ data: [{ id: "inkling-2-mini" }] }));
			else {
				res.statusCode = 404;
				res.end();
			}
		});
		const pool = makePool([{ memberId: "local-primary", endpoint: srv.endpoint, modelId: "inkling-2-mini" }]);
		const poolFile = join(makeTempDir("endo-s1-pool-"), "pool.json");
		writeFileSync(poolFile, `${JSON.stringify(pool)}\n`, "utf8");

		// 1. `endo schedule add` (coalesce-once past anchor so immediate tick claims it)
		const pastIso = new Date(Date.now() - 5_000).toISOString();
		const addRes = runCli([
			"schedule",
			"add",
			"--root",
			root,
			"--id",
			"cli-health",
			"--action",
			"observe-health",
			"--once",
			pastIso,
			"--missed-run",
			"coalesce-once",
			"--quiet",
		]);
		expect(addRes.status).toBe(0);

		// 2. `endo resource declare-window`
		const resetIso = new Date(Date.now() + 7_200_000).toISOString();
		const declRes = runCli([
			"resource",
			"declare-window",
			"--root",
			root,
			"--provider",
			"codex-subscription",
			"--reset-at",
			resetIso,
			"--window",
			"rolling-5h",
			"--quiet",
		]);
		expect(declRes.status).toBe(0);

		// 3. `endo scheduler tick --root <dir> --pool <file>` (async spawn so our in-process fake HTTP server can respond!)
		const tickRes = await runCliAsync(["scheduler", "tick", "--root", root, "--pool", poolFile, "--quiet"]);
		expect(tickRes.status).toBe(0);
		const tickJson = JSON.parse(tickRes.stdout) as {
			schedulerTick: { ok: boolean; publishedResources: boolean; tokensConsumed: number };
		};
		expect(tickJson.schedulerTick.ok).toBe(true);
		expect(tickJson.schedulerTick.publishedResources).toBe(true);
		expect(tickJson.schedulerTick.tokensConsumed).toBe(0);

		// 4. `endo resource list`
		const listRes = runCli(["resource", "list", "--root", root, "--quiet"]);
		expect(listRes.status).toBe(0);
		const listJson = JSON.parse(listRes.stdout) as {
			resources: { state: string; observation: unknown; freshness: string };
		};
		expect(listJson.resources.state).toBe("ready");
		expect(listJson.resources.freshness).toBe("fresh");

		// 5. S2 handoff seam: feed persisted S1 resources.json directly into M1 `selectCoordinatorModelV0` with ZERO new HTTP hits!
		const hitsBeforeM1 = srv.hits.length;
		const validatedSnapshot = validateEndoDevelopResourceObservationV0(listJson.resources.observation);
		const observer = createRecordedCoordinatorModelObserverV0({
			snapshot: validatedSnapshot,
			expectedPoolSha256: coordinatorModelPoolSha256V0(pool),
			now: () => validatedSnapshot.observedAtMs + 1_000,
		});
		const selection = await selectCoordinatorModelV0(pool, {}, observer);
		expect(selection.ok).toBe(true);
		if (selection.ok) {
			expect(selection.member.memberId).toBe("local-primary");
			expect(selection.observation.readiness).toBe("capacity-unknown");
		}
		expect(srv.hits.length).toBe(hitsBeforeM1); // zero duplicate network probes!

		// 6. Stale or mismatched-pool snapshot does NOT pretend healthy
		const staleObserver = createRecordedCoordinatorModelObserverV0({
			snapshot: validatedSnapshot,
			expectedPoolSha256: coordinatorModelPoolSha256V0(pool),
			now: () => validatedSnapshot.observedAtMs + validatedSnapshot.staleAfterMs + 1_000,
		});
		const staleSel = await selectCoordinatorModelV0(pool, {}, staleObserver);
		expect(staleSel.ok).toBe(false);

		// 7. `endo schedule disable`, `enable`, `remove`, `list`
		expect(runCli(["schedule", "disable", "--root", root, "--id", "cli-health", "--quiet"]).status).toBe(0);
		expect(runCli(["schedule", "enable", "--root", root, "--id", "cli-health", "--quiet"]).status).toBe(0);
		expect(runCli(["schedule", "remove", "--root", root, "--id", "cli-health", "--quiet"]).status).toBe(0);
		const finalList = runCli(["schedule", "list", "--root", root, "--include-fires", "--quiet"]);
		expect(finalList.status).toBe(0);
		const finalJson = JSON.parse(finalList.stdout) as {
			automation: { schedules: { file: { schedules: unknown[] } } };
		};
		expect(finalJson.automation.schedules.file.schedules).toHaveLength(0);
	});

	it("Adversarial H1 & H2: refresh-projection computes non-null bounded statusSha256 and never clobbers observe-health pool endpoints", async () => {
		const root = makeTempDir("endo-s1-adv-h1h2-");
		const repo = makeTempDir("endo-s1-adv-repo-");
		const tasksStore = new DevelopTasksStoreV0(root);
		const proj = tasksStore.registerProject({ name: "proj-h1", path: repo, observedGitRoot: repo });
		expect(proj.ok).toBe(true);
		if (!proj.ok) return;
		expect(tasksStore.createTask(proj.value.id, { title: "Task H1" }).ok).toBe(true);

		const srv = await startFakeServer((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/health") res.end(JSON.stringify({ status: "ok" }));
			else if (req.url === "/props")
				res.end(JSON.stringify({ build_info: "b12622-abcdef1", total_slots: 2, is_sleeping: false }));
			else if (req.url === "/models") res.end(JSON.stringify({ data: [{ id: "m-h1" }] }));
			else {
				res.statusCode = 404;
				res.end();
			}
		});
		const pool = makePool([{ memberId: "local-h1", endpoint: srv.endpoint, modelId: "m-h1" }]);
		const store = new DevelopAutomationStoreV0(root, { now: () => BASE_MS });

		// Schedule 1: observe-health at +10s
		store.addSchedule({
			scheduleId: "health-first",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		// Schedule 2: refresh-projection at +20s
		store.addSchedule({
			scheduleId: "proj-second",
			actionKind: "refresh-projection",
			trigger: { kind: "once", atMs: BASE_MS + 20_000 },
		});

		const t1 = await runEndoSchedulerTickV0({ root, now: () => BASE_MS + 10_000, pool, poolSource: "file" });
		expect(t1.ok && t1.publishedResources).toBe(true);

		// Tick 2 runs ONLY `refresh-projection` -> MUST produce non-null statusSha256 (H1) AND preserve localEndpoints from Tick 1 (H2)!
		const t2 = await runEndoSchedulerTickV0({ root, now: () => BASE_MS + 20_000, pool, poolSource: "file" });
		expect(t2.ok && t2.publishedResources).toBe(true);

		const resRead = store.readResources();
		expect(resRead.ok && resRead.exists).toBe(true);
		if (!resRead.ok || !resRead.exists) return;
		expect(resRead.value.projectionSummary).not.toBeNull();
		expect(resRead.value.projectionSummary!.statusSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(resRead.value.projectionSummary!.coordinationSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(resRead.value.projectionSummary!.gaps).not.toContain("status-observation-unavailable");
		expect(resRead.value.modelPool.localEndpoints).toHaveLength(1);
		expect(resRead.value.modelPool.localEndpoints[0]!.memberId).toBe("local-h1");
	});

	it("Adversarial H4, H5, H6: conservative retired-cursor refusal, >2048-entry pruning, and remove+readd Phase 2 race", async () => {
		// H6: remove + re-add same scheduleId at revision 1 during Phase 2 -> detected as schedule-replaced-in-flight
		const rootH6 = makeTempDir("endo-s1-adv-h6-");
		const storeH6 = new DevelopAutomationStoreV0(rootH6, { now: () => BASE_MS });
		storeH6.addSchedule({
			scheduleId: "recreated",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		const tH6 = await runEndoSchedulerTickV0({
			root: rootH6,
			now: () => BASE_MS + 10_000,
			hooks: {
				beforePhase2Probes: () => {
					expect(storeH6.removeSchedule("recreated", 1).ok).toBe(true);
					expect(
						storeH6.addSchedule({
							scheduleId: "recreated",
							actionKind: "refresh-projection",
							trigger: { kind: "once", atMs: BASE_MS + 50_000 },
						}).ok,
					).toBe(true);
				},
			},
		});
		expect(tH6.ok).toBe(true);
		if (tH6.ok) {
			expect(tH6.publishedResources).toBe(false);
			expect(tH6.outcomes[0]!.status).toBe("cancelled-schedule-changed");
			expect(tH6.outcomes[0]!.detail).toBe("schedule-replaced-in-flight");
		}
		// New recreated schedule keeps lastFireStatus: null (was NOT stamped with old fire's status)
		const afterH6 = storeH6.readSchedules();
		expect(afterH6.ok && afterH6.exists).toBe(true);
		if (afterH6.ok && afterH6.exists) {
			expect(afterH6.value.schedules[0]!.cursor.lastFireStatus).toBeNull();
			expect(afterH6.value.schedules[0]!.actionKind).toBe("refresh-projection");
		}

		// H5: >2048 claimed-incomplete files do NOT deadlock terminal fire pruning!
		const rootH5 = makeTempDir("endo-s1-adv-h5-");
		const storeH5 = new DevelopAutomationStoreV0(rootH5, { now: () => BASE_MS });
		storeH5.addSchedule({
			scheduleId: "prune-me",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});
		// Populate 2100 dummy claimed-incomplete files in fires/
		mkdirSync(storeH5.firesDir, { recursive: true });
		for (let i = 0; i < 2100; i += 1) {
			const k = i.toString(16).padStart(64, "0");
			writeFileSync(
				join(storeH5.firesDir, `${k}.claimed.json`),
				`${JSON.stringify({
					schemaVersion: "endo.develop-schedule-fire-claim.v0",
					idempotencyKey: k,
					scheduleId: "prune-me",
					scheduleRevision: 1,
					actionKind: "observe-health",
					triggerKind: "interval",
					triggerCursor: "interval:60000:1",
					windowStartMs: BASE_MS + i,
					missedWindowsBefore: 0,
					claimedAtMs: BASE_MS + i,
					leaseEpoch: 1,
					holderId: "old-holder",
				})}\n`,
				"utf8",
			);
		}
		// Run 4 completed ticks with maxFirePairsRetained=2 -> MUST prune 2 oldest terminal pairs despite >2048 incomplete entries!
		let totalPruned = 0;
		for (let i = 1; i <= 4; i += 1) {
			const res = await runEndoSchedulerTickV0({
				root: rootH5,
				now: () => BASE_MS + i * 60_000,
				maxFirePairsRetained: 2,
			});
			expect(res.ok).toBe(true);
			if (res.ok) totalPruned += res.prunedFireCount;
		}
		expect(totalPruned).toBe(2);

		// H4: Conservative refusal when retiredCursors reaches 256 (never silently evicts!)
		const rootH4 = makeTempDir("endo-s1-adv-h4-");
		const storeH4 = new DevelopAutomationStoreV0(rootH4, { now: () => BASE_MS });
		mkdirSync(storeH4.dir, { recursive: true });
		const retired256 = Array.from({ length: 256 }, (_, i) => ({
			scheduleId: `retired-${String(i).padStart(3, "0")}`,
			lastConsumedWindowStartMs: BASE_MS,
			retiredAtMs: BASE_MS,
		}));
		writeFileSync(
			storeH4.schedulesPath,
			`${JSON.stringify({
				schemaVersion: ENDO_DEVELOP_SCHEDULES_SCHEMA_V0,
				revision: 1,
				updatedAtMs: BASE_MS,
				retiredCursors: retired256,
				schedules: [
					{
						scheduleId: "active-257",
						label: null,
						revision: 1,
						enabled: true,
						actionKind: "observe-health",
						missedRunPolicy: "skip-and-report",
						trigger: { kind: "once", atMs: BASE_MS + 1_000 },
						createdAtMs: BASE_MS,
						updatedAtMs: BASE_MS,
						cursor: {
							lastEvaluatedAtMs: BASE_MS + 1_000,
							lastConsumedWindowStartMs: BASE_MS + 1_000,
							completedOnce: true,
							lastFireIdempotencyKey: null,
							lastFireStatus: "completed",
						},
					},
				],
			})}\n`,
			"utf8",
		);
		const refusedRemove = storeH4.removeSchedule("active-257");
		expect(refusedRemove.ok).toBe(false);
		if (!refusedRemove.ok) expect(refusedRemove.code).toBe("limit");
	});

	it("Adversarial M1–M7 & L1–L4: control-char Phase 2 errors, missing-lease epoch recovery, maxLeaseTtl cap, reviseSchedule reset, reserved provider, NaN maxAgeMs, MAX_EPOCH calendar", async () => {
		// M1: Phase 2 error with newlines & control characters is sanitized cleanly (does not wedge lease!)
		const rootM1 = makeTempDir("endo-s1-adv-m1-");
		const storeM1 = new DevelopAutomationStoreV0(rootM1, { now: () => BASE_MS });
		storeM1.addSchedule({
			scheduleId: "ctrl-err",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		const tM1 = await runEndoSchedulerTickV0({
			root: rootM1,
			now: () => BASE_MS + 10_000,
			probes: {
				observeProjection: async () => {
					throw new Error("boom\nwith\tcontrol\x00chars");
				},
			},
		});
		expect(tM1.ok).toBe(true);
		if (tM1.ok) {
			expect(tM1.outcomes[0]!.status).toBe("failed");
			expect(tM1.outcomes[0]!.detail).toBe("boom with control chars");
		}
		const leaseM1 = storeM1.readLease();
		expect(leaseM1.ok && leaseM1.exists && leaseM1.value.releasedAtMs !== null).toBe(true);

		// M2: Missing lease.json while resources.json holds epoch 5 -> next tick jumps directly to epoch 6 (zero wasted cycles!)
		const rootM2 = makeTempDir("endo-s1-adv-m2-");
		const storeM2 = new DevelopAutomationStoreV0(rootM2, { now: () => BASE_MS });
		storeM2.addSchedule({
			scheduleId: "epoch-recover",
			actionKind: "observe-health",
			trigger: { kind: "interval", everyMs: 60_000, anchorMs: BASE_MS + 60_000 },
		});
		for (let i = 1; i <= 5; i += 1) {
			expect((await runEndoSchedulerTickV0({ root: rootM2, now: () => BASE_MS + i * 60_000 })).ok).toBe(true);
		}
		rmSync(storeM2.leasePath, { force: true });
		const tM2 = await runEndoSchedulerTickV0({ root: rootM2, now: () => BASE_MS + 6 * 60_000 });
		expect(tM2.ok).toBe(true);
		if (tM2.ok) expect(tM2.leaseEpoch).toBe(6);

		// M3: Lease TTL exceeding maxLeaseTtlMs (300_000) refused by validator
		expect(() =>
			parseEndoDevelopAutomationLeaseV0({
				schemaVersion: ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
				holderId: "evil",
				epoch: 1,
				acquiredAtMs: BASE_MS,
				expiresAtMs: BASE_MS + 10 * 365 * 86_400_000,
				releasedAtMs: null,
			}),
		).toThrow(/exceeds maximum/);

		// M4: reviseSchedule on a completed `once` schedule resets completedOnce so the new trigger fires!
		const rootM4 = makeTempDir("endo-s1-adv-m4-");
		const storeM4 = new DevelopAutomationStoreV0(rootM4, { now: () => BASE_MS });
		storeM4.addSchedule({
			scheduleId: "once-revise",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		expect((await runEndoSchedulerTickV0({ root: rootM4, now: () => BASE_MS + 10_000 })).ok).toBe(true);
		const revM4 = storeM4.reviseSchedule({
			scheduleId: "once-revise",
			expectedRevision: 1,
			trigger: { kind: "once", atMs: BASE_MS + 50_000 },
		});
		expect(revM4.ok).toBe(true);
		if (revM4.ok) expect(revM4.value.schedule.cursor.completedOnce).toBe(false);
		const tM4 = await runEndoSchedulerTickV0({ root: rootM4, now: () => BASE_MS + 50_000 });
		expect(tM4.ok && tM4.claimed.length === 1).toBe(true);

		// M6: Disabled in-flight schedule updates cursor.lastFireStatus to `cancelled-schedule-changed` without altering operator fields
		const rootM6 = makeTempDir("endo-s1-adv-m6-");
		const storeM6 = new DevelopAutomationStoreV0(rootM6, { now: () => BASE_MS });
		storeM6.addSchedule({
			scheduleId: "dis-m6",
			actionKind: "observe-health",
			trigger: { kind: "once", atMs: BASE_MS + 10_000 },
		});
		await runEndoSchedulerTickV0({
			root: rootM6,
			now: () => BASE_MS + 10_000,
			hooks: {
				beforePhase2Probes: () => {
					storeM6.setScheduleEnabled("dis-m6", false, 1);
				},
			},
		});
		const afterM6 = storeM6.readSchedules();
		expect(afterM6.ok && afterM6.exists).toBe(true);
		if (afterM6.ok && afterM6.exists) {
			expect(afterM6.value.schedules[0]!.enabled).toBe(false);
			expect(afterM6.value.schedules[0]!.revision).toBe(2);
			expect(afterM6.value.schedules[0]!.cursor.lastFireStatus).toBe("cancelled-schedule-changed");
		}

		// M7: Reserved `local-inference` providerId refused in declareResourceWindow
		const declLocal = storeM1.declareResourceWindow({
			providerId: "local-inference",
			resetAtMs: BASE_MS + 60_000,
		});
		expect(declLocal.ok).toBe(false);
		if (!declLocal.ok) expect(declLocal.code).toBe("bad-request");

		// L1: maxAgeMs: NaN throws TypeError instead of bypassing freshness check
		const fakeSnap = validateEndoDevelopResourceObservationV0({
			schemaVersion: "endo.develop-resource-observation.v0",
			leaseEpoch: 1,
			holderId: "h1",
			observedAtMs: BASE_MS,
			publishedAtMs: BASE_MS,
			staleAfterMs: 60_000,
			tokensConsumed: 0,
			modelPool: {
				poolSha256: "a".repeat(64),
				poolSource: "file",
				localEndpoints: [
					{
						memberId: "m1",
						endpoint: "http://127.0.0.1:8091",
						modelId: "mod",
						basis: "controller-observed",
						observedAtMs: BASE_MS,
						staleAfterMs: 60_000,
						elapsedMs: 1,
						readiness: "capacity-unknown",
						detail: "slots-not-observable",
						backend: "llama.cpp-single",
						build: null,
						requests: [],
						deviceId: null,
						inferenceTokens: 0,
					},
				],
			},
			providers: [],
			sessions: [],
			worktrees: [],
			hardware: { mode: "extension-seam-unobserved", observedAtMs: BASE_MS, staleAfterMs: 60_000, devices: [] },
			projectionSummary: null,
		});
		expect(() =>
			evaluateRecordedPoolObservationV0({
				snapshot: fakeSnap,
				expectedPoolSha256: "a".repeat(64),
				member: { memberId: "m1", endpoint: "http://127.0.0.1:8091", modelId: "mod" },
				nowMs: BASE_MS + 1000,
				maxAgeMs: Number.NaN,
			}),
		).toThrow(TypeError);

		// L2: Calendar evaluation near MAX_EPOCH_MS does not throw RangeError
		const nearMaxSched = storeM1.readSchedules();
		expect(nearMaxSched.ok && nearMaxSched.exists).toBe(true);
		if (nearMaxSched.ok && nearMaxSched.exists) {
			const calSched = {
				...nearMaxSched.value.schedules[0]!,
				trigger: {
					kind: "calendar" as const,
					timezone: "UTC",
					schedule: { cadence: "daily" as const, hour: 12, minute: 0 },
					dstPolicy: "skip-nonexistent-first-ambiguous" as const,
				},
				cursor: {
					lastEvaluatedAtMs: null,
					lastConsumedWindowStartMs: null,
					completedOnce: false,
					lastFireIdempotencyKey: null,
					lastFireStatus: null,
				},
			};
			expect(() => evaluateEndoScheduleDueV0(calSched, 8.64e15 - 10_000)).not.toThrow();
		}

		// L3 & L4: invalid tick options throw TypeError; C1 control chars and leading `@` escaped/rejected in systemd args
		await expect(runEndoSchedulerTickV0({ root: rootM1, maxFirePairsRetained: -1 })).rejects.toThrow(TypeError);
		await expect(runEndoSchedulerTickV0({ root: rootM1, holderId: "bad\nholder" })).rejects.toThrow(TypeError);
		expect(() => escapeEndoSystemdExecArgV0("/tmp/\u0085bad")).toThrow(/control characters/);
		expect(escapeEndoSystemdExecArgV0("@weird")).toBe('"@weird"');
		const tmpUnits = renderEndoSystemdUnitsV0({ endoBin: "/usr/bin/endo", storeRoot: "/tmp/endo-store" });
		expect(tmpUnits.serviceContent).not.toContain("PrivateTmp=yes");
	});
});
