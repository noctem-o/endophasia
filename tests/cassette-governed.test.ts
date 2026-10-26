import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { governedCassetteSourceV0, verifyGovernedCassetteReplayV0 } from "../cli/cassette-launch-policy.ts";
import { recordPiCassetteSessionV0, replayPiCassetteSessionV0 } from "../cli/cassette-session.ts";
import { readVerifiedCheckpointCandidateV0 } from "../cli/checkpoint-candidate.ts";
import { readEndoStoreEventsV0 } from "../cli/trajectory.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { installFakePi } from "./fixtures/fake-pi/install.ts";

async function fixture(governedToolFree = true) {
	const base = mkdtempSync(join(tmpdir(), "endo-governed-cassette-"));
	const pi = installFakePi("1.0.0");
	pi.setScenario("model-endpoint");
	const upstream = await startFakeOpenAiServer({ chunkMs: 2 });
	const proxy = await startEndoRecordingProxyV0({ upstream: new URL(upstream.baseUrl).origin, log: null });
	const keySource = { kind: "fixture" as const, path: endoFixtureDigestKeyPathV0() };
	const key = loadEndoFixtureDigestKeyV0(keySource.path);
	const source = join(base, "source");
	const replay = join(base, "replay");
	const options = {
		scenario: {
			name: "text",
			purpose: "single text turn",
			workspace: {},
			steps: [{ op: "prompt" as const, text: "Reply ready" }],
		},
		pi: pi.bin,
		provider: "fake",
		model: "fake-1",
		proxy,
		store: source,
		scratchRoot: join(base, "scratch"),
		keySource,
		evidenceFrom: null,
		timeoutMs: 5000,
		governedToolFree,
		settings: { thinkingLevel: "off" },
	};
	const cleanup = async () => {
		await proxy.close();
		await upstream.close();
		pi.remove();
		rmSync(base, { recursive: true, force: true });
	};
	return { base, pi, upstream, proxy, options, source, replay, keySource, key, cleanup };
}

describe("governed cassette single-turn opt-in", () => {
	it("records no tools, replays without upstream, qualifies and rechecks durable launch evidence", async () => {
		const f = await fixture();
		try {
			expect((await recordPiCassetteSessionV0(f.options)).notes).toEqual([]);
			await f.proxy.close();
			expect(f.upstream.requests).toHaveLength(1);
			expect(f.upstream.requests[0]!.body).not.toHaveProperty("tools");
			const events = readEndoCaptureEventsV0(f.source);
			const evidence = governedCassetteSourceV0(f.source, events, f.key);
			expect(evidence?.args).toContain("--no-mcp");
			await f.upstream.close();
			const result = await replayPiCassetteSessionV0({
				store: f.source,
				out: f.replay,
				pi: f.pi.bin,
				timing: "immediate",
				keySource: f.keySource,
				timeoutMs: 5000,
			});
			expect(result).toMatchObject({
				served: 1,
				misses: 0,
				unserved: 0,
				checkpointQualification: { status: "qualified" },
			});
			for (const name of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
				expect(result.comparison.layers[name].status).toBe("EXACT");
			expect(readVerifiedCheckpointCandidateV0(f.source, f.replay, f.key).status).toBe("qualified");
			// The trajectory can still compare EXACT when launch metadata changes: qualification must re-read it.
			const event = readEndoStoreEventsV0(f.replay).find((entry) => entry.kind === "harness.attached")!;
			const store = createEndoDurableEventStoreV0(f.replay);
			store.ingest({ ...event, id: `${event.id}.duplicate`, sequence: store.length + 1 });
			store.close();
			expect(() => verifyGovernedCassetteReplayV0(f.source, f.replay, events, f.key)).toThrow("ambiguous");
			expect(readVerifiedCheckpointCandidateV0(f.source, f.replay, f.key).status).toBe("refused");
		} finally {
			await f.cleanup();
		}
	}, 30000);

	it("refuses missing, changed, mixed and downgraded source declarations before replay launch", async () => {
		const f = await fixture();
		try {
			await recordPiCassetteSessionV0(f.options);
			await f.proxy.close();
			const original = readEndoCaptureEventsV0(f.source);
			for (const mode of ["missing", "changed", "mixed", "downgraded"]) {
				const events = structuredClone(original);
				for (const event of events) {
					if (event.kind !== "capture.driver-step") continue;
					const step = event.payload as Record<string, unknown>;
					if (step.op === "open" && mode === "missing") delete step.launchEvidence;
					if (step.op === "open" && mode === "changed") step.model = "other";
					if (mode === "downgraded" || (mode === "mixed" && step.op === "close"))
						step.driver = "pi-cassette-driver.1";
				}
				expect(() => governedCassetteSourceV0(f.source, events, f.key), mode).toThrow();
			}
		} finally {
			await f.cleanup();
		}
	}, 30000);

	it("refuses environment overrides and workspace escape/startup paths without dispatch", async () => {
		const f = await fixture();
		try {
			for (const path of [
				"../agent/models.json",
				"/absolute",
				"a/../b",
				"nested/.pi/settings.json",
				"AGENTS.md",
				".env",
				"package.json",
			]) {
				await expect(
					recordPiCassetteSessionV0({
						...f.options,
						scenario: { ...f.options.scenario, workspace: { [path]: "bad" } },
					}),
				).rejects.toThrow("workspace path");
			}
			expect(f.upstream.requests).toHaveLength(0);
			await recordPiCassetteSessionV0(f.options);
			await f.proxy.close();
			const events = readEndoCaptureEventsV0(f.source);
			events.push({
				...events[0]!,
				id: "endo.event.injected.environment",
				kind: "capture.environment",
				producer: "capture:driver",
				payload: { variables: { NODE_OPTIONS: "--require=/external.js" }, files: {}, fileTime: null },
			});
			expect(() => governedCassetteSourceV0(f.source, events, f.key)).toThrow("environment overrides");
			await expect(
				replayPiCassetteSessionV0({
					store: f.source,
					out: f.replay,
					pi: f.pi.bin,
					timing: "immediate",
					keySource: f.keySource,
					timeoutMs: 5000,
					alterScratch: {
						describe: "forbidden",
						apply() {
							throw new Error("must not run");
						},
					},
				}),
			).rejects.toThrow("scratch alterations");
			expect(f.upstream.requests).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	}, 30000);

	it("cleans a rejected oversized source archive before opening capture or dispatching", async () => {
		const f = await fixture();
		try {
			await expect(
				recordPiCassetteSessionV0({
					...f.options,
					scenario: { ...f.options.scenario, workspace: { "large.txt": "x".repeat(13 * 1024 * 1024) } },
				}),
			).rejects.toThrow("archive exceeds bound");
			expect(existsSync(f.options.scratchRoot)).toBe(false);
			expect(existsSync(join(f.source, "capture"))).toBe(false);
			expect(f.upstream.requests).toHaveLength(0);
		} finally {
			await f.cleanup();
		}
	}, 30000);

	it("refuses observed tool definitions even when Pi advertised and received the disabling flags", async () => {
		const f = await fixture();
		try {
			f.pi.setScenario("model-endpoint,ignore-no-tools");
			await expect(recordPiCassetteSessionV0(f.options)).rejects.toThrow(
				"effective request model or tools mismatch",
			);
			expect(f.upstream.requests).toHaveLength(1);
			expect(f.upstream.requests[0]!.body).toHaveProperty("tools");
		} finally {
			await f.cleanup();
		}
	}, 30000);

	it("refuses a different Pi identity before replay can dispatch", async () => {
		const f = await fixture();
		try {
			await recordPiCassetteSessionV0(f.options);
			await f.proxy.close();
			f.pi.setScenario("model-endpoint,no-tool-call");
			// Changing the actual entrypoint changes the fingerprint.
			const { appendFileSync, realpathSync } = await import("node:fs");
			appendFileSync(realpathSync(f.pi.bin), "\n// changed runtime\n");
			await expect(
				replayPiCassetteSessionV0({
					store: f.source,
					out: f.replay,
					pi: f.pi.bin,
					timing: "immediate",
					keySource: f.keySource,
					timeoutMs: 5000,
				}),
			).rejects.toThrow("policy mismatch");
			expect(f.upstream.requests).toHaveLength(1);
			expect(readEndoStoreEventsV0(f.replay).some((event) => event.kind === "control.requested")).toBe(false);
		} finally {
			await f.cleanup();
		}
	}, 30000);

	it("keeps ordinary recordings ordinary and refuses unsupported opt-in configuration before launch", async () => {
		const f = await fixture(false);
		try {
			await expect(
				recordPiCassetteSessionV0({ ...f.options, governedToolFree: true, extensions: {} }),
			).rejects.toThrow("minimal");
			expect(f.upstream.requests).toHaveLength(0);
			await recordPiCassetteSessionV0(f.options);
			await f.proxy.close();
			expect(governedCassetteSourceV0(f.source, readEndoCaptureEventsV0(f.source), f.key)).toBeNull();
			expect(f.upstream.requests[0]!.body).toHaveProperty("tools");
			const report = await replayPiCassetteSessionV0({
				store: f.source,
				out: f.replay,
				pi: f.pi.bin,
				timing: "immediate",
				keySource: f.keySource,
				timeoutMs: 5000,
			});
			expect(report.checkpointQualification?.status).toBe("qualified");
		} finally {
			await f.cleanup();
		}
	}, 30000);
});
