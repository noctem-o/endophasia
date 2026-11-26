// Real child-process worker for S1 multi-process concurrency tests (S0-AT03 / S1-AT04, S0-AT04 / S1-AT05).
// Invoked via `spawn(process.execPath, [thisFile, configJson])`. Never runs in production.

import { existsSync, writeFileSync } from "node:fs";
import { runEndoSchedulerTickV0 } from "../../adapters/develop/scheduler-tick.ts";
import { parseEndoCoordinatorModelPoolV0 } from "../../protocol/coordinator-model-pool.ts";

interface WorkerConfig {
	readonly root: string;
	readonly holderId: string;
	readonly pool?: unknown;
	readonly leaseTtlMs: number;
	readonly claimNowMs: number;
	readonly publishNowMs: number;
	/** Optional file path to touch once Phase 1 claim completes. */
	readonly signalClaimedFile?: string;
	/** Optional file path to wait for before continuing into Phase 3 publication. */
	readonly waitBeforePublishFile?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for barrier file ${path}`);
		await sleep(15);
	}
}

const raw = process.argv[2];
if (raw === undefined) {
	console.error("missing worker config JSON");
	process.exit(2);
}

const cfg = JSON.parse(raw) as WorkerConfig;
const pool = cfg.pool === undefined ? null : parseEndoCoordinatorModelPoolV0(cfg.pool);

let phase: "claim" | "observe" | "publish" = "claim";
const now = (): number => (phase === "publish" ? cfg.publishNowMs : cfg.claimNowMs);

const result = await runEndoSchedulerTickV0({
	root: cfg.root,
	holderId: cfg.holderId,
	pool,
	poolSource: pool === null ? "none" : "file",
	leaseTtlMs: cfg.leaseTtlMs,
	now,
	hooks: {
		afterPhase1Claim: async () => {
			phase = "observe";
			if (cfg.signalClaimedFile !== undefined) writeFileSync(cfg.signalClaimedFile, "claimed\n", "utf8");
		},
		afterPhase2Probes: async () => {
			if (cfg.waitBeforePublishFile !== undefined) {
				await waitForFile(cfg.waitBeforePublishFile);
			}
			phase = "publish";
		},
	},
});

process.stdout.write(`${JSON.stringify(result)}\n`);
