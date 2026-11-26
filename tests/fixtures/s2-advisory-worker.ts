// Real child-process worker for the S2 multi-process admission race (tests/develop-advisory-s2.test.ts, S2-11).
// Runs one advisory tick with a fake model runner that appends one line per completion attempt to a shared file.
// Never runs in production.

import { appendFileSync } from "node:fs";
import { runEndoAdvisoryTickV0 } from "../../adapters/develop/advisory-tick.ts";

const cfg = JSON.parse(process.argv[2] ?? "{}") as { root: string; nowMs: number; holderId: string; callsFile: string };
const result = await runEndoAdvisoryTickV0({
	root: cfg.root,
	holderId: cfg.holderId,
	now: () => cfg.nowMs,
	onTimeGraceMs: 600_000,
	storeOptions: { lockWaitMs: 10_000 },
	observeMember: async (member) => ({
		memberId: member.memberId,
		endpoint: member.endpoint,
		modelId: member.modelId,
		basis: "controller-observed",
		observedAtMs: cfg.nowMs,
		elapsedMs: 1,
		readiness: "ready",
		detail: "slot-idle",
		backend: "llama.cpp-single",
		build: null,
		requests: [],
		inferenceTokens: 0,
	}),
	run: (async (_root: string, request: { projectId: string }, options: { target: { model: string } }) => {
		appendFileSync(cfg.callsFile, `${cfg.holderId}\n`);
		return {
			schemaVersion: "endo.coordinator-brief.v0",
			projectId: request.projectId,
			runtime: { harness: "OpenClaw 2026.11.7", provider: "fake", model: options.target.model },
			availability: "available",
			answer: "- ok",
			evidence: { readAtMs: 1, projectionSha256: "b".repeat(64), modelViewSha256: "c".repeat(64) },
			toolSurface: ["endophasia_status"],
		};
	}) as never,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
