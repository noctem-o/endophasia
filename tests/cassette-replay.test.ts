// Cassette sessions end to end (cli/cassette-session.ts), self-contained: the real attachment drives the
// deterministic suite's fake Pi in its `model-endpoint` mode (it streams each turn from the models.json baseUrl and
// reads files from its working directory), through the recording proxy to the fake OpenAI-compatible endpoint. Then
// each session is replayed against its cassette with a fresh fake Pi and compared with the recording.
//
// It proves the driver's mechanics (snapshot and restore at the recorded path, the recorded port, STOP and kill at the
// recorded chunk, the recorded session id, evidence carried over, the comparison), not anything about a real Pi.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EndoCaptureLogV0, endoCaptureRootV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { type EndoRecordingProxyV0, startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { exportPiCassetteFixtureV0, materializePiCassetteFixtureV0 } from "../cli/cassette-fixture.ts";
import {
	createPiCassetteScratchV0,
	type PiCassetteScenarioV0,
	piCassetteAttachmentV0,
	recordPiCassetteSessionV0,
	replayPiCassetteSessionV0,
	settlesWithin,
} from "../cli/cassette-session.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { endoDigestKeyFromEnvironmentV0 } from "../storage/digest-key.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { parseEndoWorkspaceArchiveV0 } from "../storage/workspace-snapshot.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { type FakePiInstall, installFakePi } from "./fixtures/fake-pi/install.ts";

const SCENARIOS: Record<string, PiCassetteScenarioV0> = {
	completes: {
		name: "completes",
		purpose: "short",
		workspace: {},
		steps: [{ op: "prompt", text: "Reply with ready" }],
	},
	stop: {
		name: "stop",
		purpose: "STOP mid-stream",
		workspace: {},
		steps: [{ op: "prompt-stop", text: "Count to forty", afterChunks: 5 }],
	},
	kill: {
		name: "kill",
		purpose: "kill mid-stream, reopen, prompt",
		workspace: {},
		steps: [
			{ op: "prompt-kill", text: "Count to forty", afterChunks: 5 },
			{ op: "prompt", text: "Reply with resumed" },
		],
	},
	steer: {
		name: "steer",
		purpose: "a STEER during the first response, applied through the intervention desk",
		workspace: {},
		steps: [
			{
				op: "prompt-intervene",
				text: "Count to forty",
				operation: "steer",
				message: "Endophasia steer: also say hello",
				after: { exchange: 1, chunks: 5 },
			},
		],
	},
	queue: {
		name: "queue",
		purpose: "a QUEUE (follow-up) during the first response, applied through the intervention desk",
		workspace: {},
		steps: [
			{
				op: "prompt-intervene",
				text: "Count to forty",
				operation: "queue",
				message: "Endophasia queued: then say done",
				after: { exchange: 1, chunks: 5 },
			},
		],
	},
	"intervene-stop": {
		name: "intervene-stop",
		purpose: "a STOP mid-response, applied through the intervention desk",
		workspace: {},
		steps: [{ op: "prompt-intervene", text: "Count to forty", operation: "stop", after: { exchange: 1, chunks: 5 } }],
	},
	tool: {
		name: "tool",
		purpose: "the model asks to read a workspace file",
		workspace: { "endophasia-study.txt": "a synthetic workspace file\n" },
		steps: [{ op: "prompt", text: "Use the read tool, then answer" }],
	},
};

let base: string;
let install: FakePiInstall;
let upstream: FakeOpenAiServer;
let proxy: EndoRecordingProxyV0;
const recorded: Record<string, string> = {};

beforeAll(async () => {
	base = mkdtempSync(join(tmpdir(), "endo-cassette-e2e-"));
	install = installFakePi("1.0.0");
	install.setScenario("model-endpoint");
	upstream = await startFakeOpenAiServer({ chunkMs: 2, slowChunkMs: 25 });
	proxy = await startEndoRecordingProxyV0({ upstream: new URL(upstream.baseUrl).origin, log: null });
	// Capability evidence (steering.stop) through the same port and an identical models.json.
	const checks = join(base, "root-checks");
	const checksLog = new EndoCaptureLogV0(checks, endoDigestKeyFromEnvironmentV0(), "record", { async: true });
	proxy.log = checksLog;
	const scratch = createPiCassetteScratchV0(join(base, "checks"), {
		baseUrl: `${proxy.origin}/v1`,
		provider: "fake",
		model: "fake-1",
		files: {},
	});
	const pi = piCassetteAttachmentV0({
		root: checks,
		scratchRoot: scratch.root,
		pi: install.bin,
		provider: "fake",
		model: "fake-1",
		keySource: { kind: "installation" },
		requestTimeoutMs: 20_000,
	});
	await pi.identify();
	await pi.checkLocal();
	await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
	await proxy.flush();
	proxy.log = null;
	checksLog.close();
	for (const [name, scenario] of Object.entries(SCENARIOS)) {
		const store = join(base, `root-${name}`);
		await recordPiCassetteSessionV0({
			scenario,
			pi: install.bin,
			provider: "fake",
			model: "fake-1",
			proxy,
			store,
			scratchRoot: join(base, `scratch-${name}`),
			keySource: { kind: "installation" },
			evidenceFrom: checks,
			timeoutMs: 20_000,
		});
		recorded[name] = store;
	}
	// A replay binds the port the proxy listened on: it must be free.
	await proxy.close();
}, 120_000);

afterAll(async () => {
	await proxy?.close();
	await upstream?.close();
	install?.remove();
	rmSync(base, { recursive: true, force: true });
});

/** Every event in a session store (its own event log, not the capture log). */
function sessionEvents(root: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	const all: EndoEventV0[] = [];
	for (let after = 0; ; ) {
		const page = store.page({ afterSequence: after, limit: 10_000 });
		if (page.events.length === 0) break;
		all.push(...page.events);
		after = page.nextAfterSequence;
	}
	store.close();
	return all;
}

const exchanges = (store: string) =>
	readEndoCaptureEventsV0(store)
		.filter((event) => event.kind === "capture.exchange-ended")
		.map((event) => event.payload as { outcome: string; chunks: unknown[] });

async function replayWith(name: string, apply: (root: string) => void) {
	const out = join(base, `replay-${name}-altered-${Math.random().toString(16).slice(2)}`);
	const report = await replayPiCassetteSessionV0({
		store: recorded[name]!,
		out,
		pi: install.bin,
		timing: "immediate",
		keySource: { kind: "installation" },
		timeoutMs: 20_000,
		holdMs: 5_000,
		alterScratch: { describe: "test alteration", apply },
	});
	return { report, out };
}

async function replay(name: string, timing: "immediate" | "as-recorded" = "immediate", pi: string = install.bin) {
	const out = join(base, `replay-${name}-${timing}-${Math.random().toString(16).slice(2)}`);
	const report = await replayPiCassetteSessionV0({
		store: recorded[name]!,
		out,
		pi,
		timing,
		keySource: { kind: "installation" },
		timeoutMs: 20_000,
		holdMs: 5_000,
	});
	return { report, out };
}

describe("cassette sessions: record through the proxy, replay against the cassette (fake Pi, fake upstream)", () => {
	it("records each scenario's exchanges, the snapshot and the driver's steps; the scratch root is gone afterwards", () => {
		expect(exchanges(recorded.completes!).map((entry) => entry.outcome)).toEqual(["complete"]);
		expect(exchanges(recorded.stop!).map((entry) => entry.outcome)).toEqual(["client-disconnected"]);
		expect(exchanges(recorded.kill!).map((entry) => entry.outcome)).toEqual(["client-disconnected", "complete"]);
		expect(exchanges(recorded.tool!).map((entry) => entry.outcome)).toEqual(["complete", "complete"]);
		const ops = readEndoCaptureEventsV0(recorded.kill!)
			.filter((event) => event.kind === "capture.driver-step")
			.map((event) => (event.payload as { op: string }).op);
		expect(ops).toEqual(["prompt", "open-child", "kill", "reopen", "prompt", "settled", "close"]);
		expect(existsSync(join(base, "scratch-tool"))).toBe(false);
	});

	it.each(["completes", "stop", "kill", "tool"])(
		"a replay of %s reproduces lifecycle, tools and outcome exactly",
		async (name) => {
			const { report, out } = await replay(name);
			expect(report.misses).toBe(0);
			expect(report.unserved).toBe(0);
			expect(report.served).toBe(exchanges(recorded[name]!).length);
			for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
				expect(report.comparison.layers[layer].status, layer).toBe("EXACT");
			expect(report.comparison.flags).toEqual([]);
			expect(
				report.notes.filter((note) => !note.startsWith("the Endophasia child") && !note.startsWith("Pi ended")),
			).toEqual([]);
			// The replay recorded what it served, and its own driver steps.
			const served = readEndoCaptureEventsV0(out).filter((event) => event.kind === "capture.served");
			expect(served.length).toBe(report.served);
		},
	);

	it("the tool scenario's read sees the restored workspace: its result digest matches the recording", async () => {
		const { report } = await replay("tool");
		expect(report.comparison.layers.toolCalls).toMatchObject({ status: "EXACT", length: 1 });
		expect(report.comparison.layers.toolResults).toMatchObject({ status: "EXACT", length: 1 });
	});

	it("STOP lands after the recorded chunk in as-recorded timing too", async () => {
		const { report } = await replay("stop", "as-recorded");
		expect(report.comparison.layers.outcome.status).toBe("EXACT");
		expect(report.misses).toBe(0);
	});

	it("a fixture exported to files and materialized again replays the same way", async () => {
		const dir = join(base, "fixture-tool");
		exportPiCassetteFixtureV0(recorded.tool!, dir);
		const store = materializePiCassetteFixtureV0(dir, join(base, "materialized-tool"));
		const report = await replayPiCassetteSessionV0({
			store,
			out: join(base, "replay-materialized-tool"),
			pi: install.bin,
			timing: "immediate",
			keySource: { kind: "installation" },
			timeoutMs: 20_000,
		});
		for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
			expect(report.comparison.layers[layer].status).toBe("EXACT");
	});

	it("negative control: a Pi whose control flow differs under the same model outputs diverges where it differs", async () => {
		const other = installFakePi("1.0.0");
		other.setScenario("model-endpoint,unknown-lifecycle");
		try {
			const { report } = await replay("completes", "immediate", other.bin);
			expect(report.misses).toBe(0);
			expect(report.comparison.layers.lifecycle).toMatchObject({ status: "DIVERGED" });
			expect(report.comparison.layers.outcome.status).toBe("EXACT");
		} finally {
			other.remove();
		}
	});

	it("negative control: a Pi whose request differs is an explicit cassette miss, and the run fails visibly", async () => {
		const other = installFakePi("1.0.0");
		other.setScenario("model-endpoint,system-variant");
		try {
			const { report, out } = await replay("completes", "immediate", other.bin);
			expect(report.misses).toBeGreaterThan(0);
			expect(report.served).toBe(0);
			const misses = readEndoCaptureEventsV0(out).filter((event) => event.kind === "capture.cassette-miss");
			expect(misses[0]!.payload).toMatchObject({
				reason: "unexpected-request",
				exchange: 1,
				divergence: { kind: "control-flow", message: 1, role: "system" },
			});
			expect(report.environmentDivergedAt).toBeNull();
			expect(report.comparison.layers.outcome).toMatchObject({ status: "DIVERGED", index: 0 });
		} finally {
			other.remove();
		}
	});

	it("a tool that observes a changed workspace: the miss says environment diverged at that exchange, not control flow", async () => {
		const { report } = await replayWith("tool", (root) =>
			writeFileSync(join(root, "work", "endophasia-study.txt"), "different content\n"),
		);
		expect(report.environmentDivergedAt).toBe(2);
		expect(report.missDetails[0]).toMatchObject({
			exchange: 2,
			reason: "unexpected-request",
			divergence: { kind: "environment", role: "tool" },
		});
	});

	it("restored file times are the recorded ones (state, not time): an untouched workspace replays EXACT", async () => {
		const events = readEndoCaptureEventsV0(recorded.tool!);
		const snapshot = events.find((event) => event.kind === "capture.workspace-snapshot")!.payload as {
			archive: unknown;
		};
		expect(snapshot.archive).toBeDefined();
		let seen = 0;
		const { report } = await replayWith("tool", (root) => {
			seen = Math.floor(statSync(join(root, "work", "endophasia-study.txt")).mtimeMs);
		});
		expect(seen).toBeLessThan(Date.now() - 1000);
		expect(report.misses).toBe(0);
	});

	it("a wait leaves no timer behind: a long timeout must not keep the process alive after the event arrives", async () => {
		const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
		const before = timers();
		expect(await settlesWithin(Promise.resolve(), 600_000)).toBe(true);
		expect(timers()).toBe(before);
		expect(await settlesWithin(new Promise(() => {}), 20)).toBe(false);
		expect(timers()).toBe(before);
	});

	describe("steered sessions (STEER, QUEUE and STOP through the intervention desk)", () => {
		const chain = (name: string) =>
			sessionEvents(recorded[name]!).filter((event) => event.kind.startsWith("intervention."));

		it.each([
			["steer", "steer", "Endophasia steer: also say hello", 2],
			["queue", "queue", "Endophasia queued: then say done", 2],
		])(
			"%s: the full chain is recorded, and consumption is observed in the proxy capture, not assumed",
			(name, operation, message, exchange) => {
				const records = chain(name);
				expect(records.map((event) => event.kind)).toEqual([
					"intervention.proposal",
					"intervention.authorization",
					"intervention.request",
					"intervention.accepted",
					"intervention.consumed",
					"intervention.consequence",
				]);
				expect(records[0]!.payload).toMatchObject({ operation, origin: "operator-scenario" });
				expect(records[1]!.payload).toMatchObject({
					decision: "allow",
					authority: { kind: "local-operator", confirmation: "scenario" },
				});
				// Applied at the recorded delivery point, and consumed in the next exchange's request.
				expect(records[2]!.payload).toMatchObject({ at: { exchange: 1 } });
				expect(records[4]!.payload).toMatchObject({ exchange });
				expect(records[5]!.payload).toMatchObject({
					acceptance: { status: "accepted", disposition: "queued" },
					consumption: { status: "observed", exchange },
				});
				// The message is outside canonical evidence: the records carry only its keyed digest.
				expect(JSON.stringify(records)).not.toContain(message);
				// The proxy capture holds the message (exchange 2's request body), which is what consumption points at.
				const driverStep = readEndoCaptureEventsV0(recorded[name]!)
					.filter((event) => event.kind === "capture.driver-step")
					.map((event) => event.payload as { op: string; driver: string; at?: unknown });
				expect(new Set(driverStep.map((entry) => entry.driver))).toEqual(new Set(["pi-cassette-driver.2"]));
				expect(driverStep.map((entry) => entry.op)).toEqual(["open", "prompt", "intervene", "settled", "close"]);
			},
		);

		it("stop: requested through the desk, nothing to consume, and the run ended aborted as Pi reported it", () => {
			const records = chain("intervene-stop");
			expect(records.map((event) => event.kind)).toEqual([
				"intervention.proposal",
				"intervention.authorization",
				"intervention.request",
				"intervention.accepted",
				"intervention.consequence",
			]);
			expect(records[4]!.payload).toMatchObject({
				consumption: { status: "not-applicable", reason: "stop carries no message to consume" },
				effect: { lastRunEnding: "aborted" },
			});
		});

		it.each(["steer", "queue", "intervene-stop"])(
			"%s: intervention records do not disturb the lifecycle (no anomaly, no unrecognized event)",
			(name) => {
				const kinds = sessionEvents(recorded[name]!).map((event) => event.kind);
				expect(
					kinds.filter((kind) => kind === "lifecycle.anomaly" || kind === "lifecycle.unrecognized-runtime-event"),
				).toEqual([]);
			},
		);

		it.each([
			["steer", "immediate"],
			["steer", "immediate"],
			["steer", "immediate"],
			["steer", "as-recorded"],
			["steer", "as-recorded"],
			["queue", "immediate"],
			["queue", "immediate"],
			["queue", "immediate"],
			["queue", "as-recorded"],
			["queue", "as-recorded"],
			["intervene-stop", "immediate"],
			["intervene-stop", "immediate"],
			["intervene-stop", "immediate"],
			["intervene-stop", "as-recorded"],
			["intervene-stop", "as-recorded"],
		] as const)(
			"a replay of %s (%s) re-issues the intervention at the recorded point and is EXACT",
			async (name, timing) => {
				const { report, out } = await replay(name, timing);
				expect(report.misses).toBe(0);
				expect(report.unserved).toBe(0);
				for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
					expect(report.comparison.layers[layer].status, layer).toBe("EXACT");
				expect(report.interventions).toEqual([
					{
						operation: name === "intervene-stop" ? "stop" : name,
						recordedAt: { exchange: 1, chunks: 5 },
						reissuedAt: { exchange: 1, chunks: 5 },
						proposalDigestMatches: true,
						result: "accepted",
					},
				]);
				// The replay's own store records the re-issued chain, and no lifecycle anomaly.
				const kinds = sessionEvents(out).map((event) => event.kind);
				expect(kinds.filter((kind) => kind.startsWith("intervention."))).toEqual([
					"intervention.proposal",
					"intervention.authorization",
					"intervention.request",
					"intervention.accepted",
				]);
				expect(kinds).not.toContain("lifecycle.anomaly");
			},
		);

		it("a replayer meeting a driver step it does not know refuses, instead of skipping it", async () => {
			const dir = join(base, "fixture-steer-unknown");
			exportPiCassetteFixtureV0(recorded.steer!, dir);
			const file = join(dir, "capture.events.jsonl");
			const text = readFileSync(file, "utf8");
			expect(text).toContain('"op":"settled"');
			writeFileSync(file, text.replaceAll('"op":"settled"', '"op":"settled-v3"'));
			const store = materializePiCassetteFixtureV0(dir, join(base, "materialized-steer-unknown"));
			await expect(
				replayPiCassetteSessionV0({
					store,
					out: join(base, "replay-steer-unknown"),
					pi: install.bin,
					timing: "immediate",
					keySource: { kind: "installation" },
					timeoutMs: 20_000,
					holdMs: 5_000,
				}),
			).rejects.toThrow(/does not know: settled-v3/);
		});
	});

	it("a pinned environment reaches Pi on record and on replay; it is recorded, and the snapshot holds its files and times", async () => {
		const envLog = join(base, "env-log.jsonl");
		const scratchRoot = join(base, "scratch-pinned");
		const store = join(base, "root-pinned");
		const reporter = "export default async function* reporter() {}\n";
		const fileTime = "2026-01-01T00:00:00Z";
		const seen = () =>
			readFileSync(envLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		const expected = {
			TZ: "UTC",
			LC_ALL: "C",
			LANG: null,
			NODE_OPTIONS: `--test-reporter=${scratchRoot}/env/reporter.mjs`,
		};
		// The session process (which runs every tool) sees the variables; the identity probe (`--version`) runs with its
		// minimal environment, so Pi's fingerprint does not depend on the pinning.
		const expectPinned = (lines: { version: boolean }[]) => {
			const sessions = lines.filter((line) => !line.version);
			expect(sessions.length).toBeGreaterThan(0);
			for (const line of sessions) expect(line).toEqual({ version: false, ...expected });
			for (const line of lines.filter((entry) => entry.version))
				expect(line).toEqual({ version: true, TZ: null, LC_ALL: null, LANG: null, NODE_OPTIONS: null });
		};
		install.setEnvLog(envLog);
		try {
			const pinnedProxy = await startEndoRecordingProxyV0({ upstream: new URL(upstream.baseUrl).origin, log: null });
			try {
				await recordPiCassetteSessionV0({
					scenario: SCENARIOS.tool!,
					pi: install.bin,
					provider: "fake",
					model: "fake-1",
					proxy: pinnedProxy,
					store,
					scratchRoot,
					keySource: { kind: "installation" },
					evidenceFrom: null,
					timeoutMs: 20_000,
					environment: {
						variables: { TZ: "UTC", LC_ALL: "C", NODE_OPTIONS: "--test-reporter={root}/env/reporter.mjs" },
						files: { "reporter.mjs": reporter },
						fileTime,
					},
				});
			} finally {
				await pinnedProxy.close();
			}
			expectPinned(seen());

			const events = readEndoCaptureEventsV0(store);
			expect(events.find((event) => event.kind === "capture.environment")?.payload).toEqual({
				variables: { TZ: "UTC", LC_ALL: "C", NODE_OPTIONS: expected.NODE_OPTIONS },
				fileTime,
				files: {
					"reporter.mjs": {
						sha256: createHash("sha256").update(reporter).digest("hex"),
						bytes: Buffer.byteLength(reporter),
					},
				},
			});
			const snapshot = events.find((event) => event.kind === "capture.workspace-snapshot")!.payload as unknown as {
				archive: { digest: EndoKeyedDigestV0 };
			};
			const archive = parseEndoWorkspaceArchiveV0(
				createEndoBlobStoreV0(endoCaptureRootV0(store), endoDigestKeyFromEnvironmentV0(), { readOnly: true }).get(
					snapshot.archive.digest,
				),
			);
			expect(archive.rootMtimeMs).toBe(Date.parse(fileTime));
			expect(new Set(archive.entries.map((entry) => entry.mtimeMs))).toEqual(new Set([Date.parse(fileTime)]));
			expect(archive.entries.map((entry) => entry.path)).toEqual(
				expect.arrayContaining(["env/reporter.mjs", "work/endophasia-study.txt", "agent/models.json"]),
			);

			writeFileSync(envLog, "");
			const out = join(base, "replay-pinned");
			const report = await replayPiCassetteSessionV0({
				store,
				out,
				pi: install.bin,
				timing: "immediate",
				keySource: { kind: "installation" },
				timeoutMs: 20_000,
				holdMs: 5_000,
			});
			expect(report.misses).toBe(0);
			for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
				expect(report.comparison.layers[layer].status, layer).toBe("EXACT");
			expectPinned(seen());
		} finally {
			install.setEnvLog("/dev/null");
		}
	});

	it("a session without a pinned environment records none, and Pi sees none of its variables", () => {
		expect(readEndoCaptureEventsV0(recorded.tool!).some((event) => event.kind === "capture.environment")).toBe(false);
	});

	it("a replay leaves nothing at the recorded path: the restored root and any parent it had to create are removed", async () => {
		const events = readEndoCaptureEventsV0(recorded.completes!);
		const snapshot = events.find((event) => event.kind === "capture.workspace-snapshot")!.payload as {
			scratchRoot: string;
		};
		await replay("completes");
		expect(existsSync(snapshot.scratchRoot)).toBe(false);
	});

	it("refuses to replay while the recorded scratch root exists (it restores at the same path, never elsewhere)", async () => {
		const events = readEndoCaptureEventsV0(recorded.completes!);
		const snapshot = events.find((event) => event.kind === "capture.workspace-snapshot")!.payload as {
			scratchRoot: string;
		};
		mkdirSync(snapshot.scratchRoot, { recursive: true });
		try {
			await expect(replay("completes")).rejects.toThrow(/exists; a replay restores it at the same path/);
		} finally {
			rmSync(snapshot.scratchRoot, { recursive: true, force: true });
		}
	});
});
