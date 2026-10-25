// Faults are injected only into this isolated test process after a genuine fake-Pi replay has qualified a receipt.
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type EndoRecordingProxyV0, startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { recordPiCassetteSessionV0, replayPiCassetteSessionV0 } from "../cli/cassette-session.ts";
import { materializeVerifiedInitialCheckpointV0 } from "../cli/checkpoint-materialization.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { type FakePiInstall, installFakePi } from "./fixtures/fake-pi/install.ts";

const fault = vi.hoisted(() => ({ mode: "none", source: "" }));
vi.mock("../storage/workspace-snapshot.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../storage/workspace-snapshot.ts")>();
	const fs = await import("node:fs");
	const path = await import("node:path");
	return {
		...original,
		restoreEndoWorkspaceV0(bytes: Uint8Array, directory: string) {
			const restored = original.restoreEndoWorkspaceV0(bytes, directory);
			if (fault.mode === "throw-after-restore" && path.basename(directory).startsWith("endo-initial-scratch-"))
				throw new Error("isolated injected failure after restore");
			return restored;
		},
		archiveEndoWorkspaceV0(directory: string) {
			if (path.basename(directory).startsWith("endo-initial-scratch-")) {
				if (fault.mode === "content-mismatch")
					fs.writeFileSync(path.join(directory, "agent", "models.json"), "changed after restore");
				if (fault.mode === "source-mutation")
					fs.appendFileSync(path.join(fault.source, "capture", "events", "events.log"), Buffer.from([0x01]));
			}
			return original.archiveEndoWorkspaceV0(directory);
		},
	};
});

let base: string;
let install: FakePiInstall;
let upstream: FakeOpenAiServer;
let proxy: EndoRecordingProxyV0;
let source: string;
let replay: string;
const keyPath = endoFixtureDigestKeyPathV0();
const key = loadEndoFixtureDigestKeyV0(keyPath);

beforeAll(async () => {
	base = mkdtempSync(join(tmpdir(), "endo-materialize-fault-"));
	install = installFakePi("1.0.0");
	install.setScenario("model-endpoint");
	upstream = await startFakeOpenAiServer({ chunkMs: 2 });
	proxy = await startEndoRecordingProxyV0({ upstream: new URL(upstream.baseUrl).origin, log: null });
	source = join(base, "source");
	await recordPiCassetteSessionV0({
		scenario: {
			name: "completes",
			purpose: "short",
			workspace: {},
			steps: [{ op: "prompt", text: "Reply with ready" }],
		},
		pi: install.bin,
		provider: "fake",
		model: "fake-1",
		proxy,
		store: source,
		scratchRoot: join(base, "scratch"),
		keySource: { kind: "fixture", path: keyPath },
		evidenceFrom: null,
		timeoutMs: 20_000,
	});
	await proxy.close();
	replay = join(base, "replay");
	const report = await replayPiCassetteSessionV0({
		store: source,
		out: replay,
		pi: install.bin,
		timing: "immediate",
		keySource: { kind: "fixture", path: keyPath },
		timeoutMs: 20_000,
	});
	expect(report.checkpointQualification).toEqual({ status: "qualified" });
}, 120_000);

afterAll(async () => {
	fault.mode = "none";
	await proxy?.close();
	await upstream?.close();
	install?.remove();
	rmSync(base, { recursive: true, force: true });
});

describe("checkpoint materialization partial-failure cleanup", () => {
	it.each([
		["throw-after-restore", "materialization-failed"],
		["content-mismatch", "restored-state-mismatch"],
		["source-mutation", "evidence-changed"],
	] as const)("removes only its new child after %s", (mode, reason) => {
		const parent = mkdtempSync(join(base, "output-"));
		const sentinel = join(parent, "unrelated.txt");
		writeFileSync(sentinel, "keep me");
		const sourceForCall = mode === "source-mutation" ? join(base, "source-copy") : source;
		if (mode === "source-mutation") cpSync(source, sourceForCall, { recursive: true });
		fault.source = sourceForCall;
		fault.mode = mode;
		try {
			const result = materializeVerifiedInitialCheckpointV0(sourceForCall, replay, key, parent);
			expect(result).toMatchObject({ status: "refused", reason });
			expect(readdirSync(parent)).toEqual(["unrelated.txt"]);
		} finally {
			fault.mode = "none";
		}
	});
});
