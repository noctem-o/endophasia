// A real fake-Pi recording and fresh cassette replay qualify the receipt before this filesystem-only consumer runs.
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endoCaptureRootV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { type EndoRecordingProxyV0, startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import {
	type PiCassetteScenarioV0,
	recordPiCassetteSessionV0,
	replayPiCassetteSessionV0,
} from "../cli/cassette-session.ts";
import { readVerifiedCheckpointCandidateV0 } from "../cli/checkpoint-candidate.ts";
import { materializeVerifiedInitialCheckpointV0 } from "../cli/checkpoint-materialization.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { type EndoKeyedDigestV0, endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import {
	archiveEndoWorkspaceV0,
	pinEndoWorkspaceTimesV0,
	restoreEndoWorkspaceV0,
} from "../storage/workspace-snapshot.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { type FakePiInstall, installFakePi } from "./fixtures/fake-pi/install.ts";

const keyPath = endoFixtureDigestKeyPathV0();
const key = loadEndoFixtureDigestKeyV0(keyPath);
const keySource = { kind: "fixture" as const, path: keyPath };
const scenarios: Record<string, PiCassetteScenarioV0> = {
	completes: {
		name: "completes",
		purpose: "short",
		workspace: {},
		steps: [{ op: "prompt", text: "Reply with ready" }],
	},
	tool: {
		name: "tool",
		purpose: "read a seeded file",
		workspace: { "endophasia-study.txt": "initial scratch content\n" },
		steps: [{ op: "prompt", text: "Use the read tool, then answer" }],
	},
};

let base: string;
let install: FakePiInstall;
let upstream: FakeOpenAiServer;
let proxy: EndoRecordingProxyV0;
const recorded: Record<string, string> = {};
let serial = 0;
const next = (name: string) => join(base, `${name}-${++serial}`);
const privateParent = () => mkdtempSync(join(base, "output-"));

beforeAll(async () => {
	base = mkdtempSync(join(tmpdir(), "endo-materialize-e2e-"));
	install = installFakePi("1.0.0");
	install.setScenario("model-endpoint");
	upstream = await startFakeOpenAiServer({ chunkMs: 2 });
	proxy = await startEndoRecordingProxyV0({ upstream: new URL(upstream.baseUrl).origin, log: null });
	for (const [name, scenario] of Object.entries(scenarios)) {
		const store = next(`source-${name}`);
		await recordPiCassetteSessionV0({
			scenario,
			pi: install.bin,
			provider: "fake",
			model: "fake-1",
			proxy,
			store,
			scratchRoot: next(`scratch-${name}`),
			keySource,
			evidenceFrom: null,
			timeoutMs: 20_000,
		});
		recorded[name] = store;
	}
	await proxy.close();
}, 120_000);

afterAll(async () => {
	await proxy?.close();
	await upstream?.close();
	install?.remove();
	rmSync(base, { recursive: true, force: true });
});

async function replay(source: string) {
	const out = next("replay");
	const report = await replayPiCassetteSessionV0({
		store: source,
		out,
		pi: install.bin,
		timing: "immediate",
		keySource,
		timeoutMs: 20_000,
	});
	expect(report.misses).toBe(0);
	expect(report.unserved).toBe(0);
	expect(report.checkpointQualification).toEqual({ status: "qualified" });
	for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
		expect(report.comparison.layers[layer].status).toBe("EXACT");
	return out;
}

function archiveBytes(source: string, out: string): Uint8Array {
	const verified = readVerifiedCheckpointCandidateV0(source, out, key);
	expect(verified.status).toBe("qualified");
	if (verified.status !== "qualified") throw new Error("the test replay did not qualify");
	return createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(
		verified.candidate.archive.digest,
	);
}

function rewriteCapture(root: string, mutate: (events: EndoEventV0[]) => void): void {
	const events = structuredClone(readEndoCaptureEventsV0(root));
	mutate(events);
	rmSync(join(endoCaptureRootV0(root), "events", "events.log"));
	const store = createEndoDurableEventStoreV0(endoCaptureRootV0(root));
	try {
		for (const event of events) store.ingest(event);
	} finally {
		store.close();
	}
}

describe("verified initial scratch materialization", () => {
	it("consumes a genuine simple replay receipt, rearchives exactly, and repeats into distinct private directories", async () => {
		const source = recorded.completes!;
		const out = await replay(source);
		const snapshot = readEndoCaptureEventsV0(source).find((event) => event.kind === "capture.workspace-snapshot")!;
		const originalScratch = (snapshot.payload as { scratchRoot: string }).scratchRoot;
		expect(existsSync(originalScratch)).toBe(false);
		const parent = privateParent();
		const first = materializeVerifiedInitialCheckpointV0(source, out, key, parent);
		const second = materializeVerifiedInitialCheckpointV0(source, out, key, parent);
		expect(first.status).toBe("materialized");
		expect(second.status).toBe("materialized");
		if (first.status !== "materialized" || second.status !== "materialized") return;
		expect(first.kind).toBe("verified-initial-scratch-materialization");
		expect(first.directory).not.toBe(second.directory);
		expect(first.directory).not.toBe(originalScratch);
		expect(statSync(first.directory).mode & 0o077).toBe(0);
		const bytes = archiveBytes(source, out);
		for (const directory of [first.directory, second.directory])
			expect(Buffer.from(archiveEndoWorkspaceV0(directory).bytes).equals(Buffer.from(bytes))).toBe(true);
		expect(existsSync(originalScratch)).toBe(false);
	});

	it("restores the tool scenario's pre-execution input, without executing Pi or changing the source", async () => {
		const source = recorded.tool!;
		const out = await replay(source);
		const before = readEndoCaptureEventsV0(source);
		const callsBefore = upstream.requests.length;
		const result = materializeVerifiedInitialCheckpointV0(source, out, key, privateParent());
		expect(result.status).toBe("materialized");
		if (result.status !== "materialized") return;
		expect(readFileSync(join(result.directory, "work", "endophasia-study.txt"), "utf8")).toBe(
			"initial scratch content\n",
		);
		expect(archiveEndoWorkspaceV0(result.directory).bytes).toEqual(archiveBytes(source, out));
		expect(readEndoCaptureEventsV0(source)).toEqual(before);
		expect(upstream.requests.length).toBe(callsBefore);
	});

	it("preserves an internal link, executable bit, and file, directory, link and root times from a verified v1 archive", async () => {
		const source = next("source-with-metadata");
		cpSync(recorded.completes!, source, { recursive: true });
		const originalSnapshot = readEndoCaptureEventsV0(source).find(
			(event) => event.kind === "capture.workspace-snapshot",
		)!;
		const originalRef = (originalSnapshot.payload as unknown as { archive: { digest: EndoKeyedDigestV0 } }).archive
			.digest;
		const originalBytes = createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(originalRef);
		const tree = next("metadata-tree");
		restoreEndoWorkspaceV0(originalBytes, tree);
		mkdirSync(join(tree, "work", "bin"));
		writeFileSync(join(tree, "work", "bin", "run.sh"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(tree, "work", "bin", "run.sh"), 0o755);
		symlinkSync("bin/run.sh", join(tree, "work", "run-link"));
		pinEndoWorkspaceTimesV0(tree, Date.parse("2024-03-04T05:06:07.123Z"));
		const archive = archiveEndoWorkspaceV0(tree);
		const ref = createEndoBlobStoreV0(endoCaptureRootV0(source), key).put(archive.bytes);
		rewriteCapture(source, (events) => {
			const snapshot = events.find((event) => event.kind === "capture.workspace-snapshot")!;
			(snapshot.payload as { archive: unknown; summary: unknown }).archive = {
				digest: ref.digest,
				bytes: ref.bytes,
			};
			(snapshot.payload as { summary: unknown }).summary = archive.summary;
		});
		const out = await replay(source);
		const result = materializeVerifiedInitialCheckpointV0(source, out, key, privateParent());
		expect(result.status).toBe("materialized");
		if (result.status !== "materialized") return;
		expect(readlinkSync(join(result.directory, "work", "run-link"))).toBe("bin/run.sh");
		expect(lstatSync(join(result.directory, "work", "run-link")).isSymbolicLink()).toBe(true);
		expect(statSync(join(result.directory, "work", "bin", "run.sh")).mode & 0o111).not.toBe(0);
		for (const path of ["", "work", "work/bin", "work/bin/run.sh", "work/run-link"])
			expect(Math.floor(lstatSync(join(result.directory, path)).mtimeMs)).toBe(
				Date.parse("2024-03-04T05:06:07.123Z"),
			);
		expect(archiveEndoWorkspaceV0(result.directory).bytes).toEqual(archive.bytes);
	});

	it("refuses missing, stale, and mutated evidence before allocating a destination", async () => {
		const source = recorded.completes!;
		const out = await replay(source);
		const parent = privateParent();
		const before = statSync(parent).mtimeMs;
		const missing = next("missing-receipt");
		cpSync(out, missing, { recursive: true });
		rmSync(join(missing, "replay-artifacts", "checkpoint-candidate.json"));
		expect(materializeVerifiedInitialCheckpointV0(source, missing, key, parent)).toMatchObject({
			status: "refused",
			reason: "candidate-unverified",
		});
		const stale = next("stale-receipt");
		cpSync(out, stale, { recursive: true });
		writeFileSync(join(stale, "replay-artifacts", "checkpoint-candidate.json"), "{}\n");
		expect(materializeVerifiedInitialCheckpointV0(source, stale, key, parent).status).toBe("refused");
		const changed = next("mutated-source");
		cpSync(source, changed, { recursive: true });
		rewriteCapture(changed, (events) => {
			const snapshot = events.find((event) => event.kind === "capture.workspace-snapshot")!;
			(snapshot.payload as { workspace: string }).workspace = "other";
		});
		expect(materializeVerifiedInitialCheckpointV0(changed, out, key, parent).status).toBe("refused");
		const damaged = next("damaged-source");
		cpSync(source, damaged, { recursive: true });
		appendFileSync(join(damaged, "capture", "events", "events.log"), Buffer.from([0x01]));
		expect(materializeVerifiedInitialCheckpointV0(damaged, out, key, parent).status).toBe("refused");
		const damagedReplay = next("damaged-replay");
		cpSync(out, damagedReplay, { recursive: true });
		appendFileSync(join(damagedReplay, "events", "events.log"), Buffer.from([0x01]));
		expect(materializeVerifiedInitialCheckpointV0(source, damagedReplay, key, parent).status).toBe("refused");
		expect(statSync(parent).mtimeMs).toBe(before);
		expect(existsSync(join(out, "replay-artifacts", "checkpoint-candidate.json"))).toBe(true);
	});

	it("refuses missing or substituted archive blobs and another digest domain", async () => {
		const source = recorded.completes!;
		const out = await replay(source);
		const verified = readVerifiedCheckpointCandidateV0(source, out, key);
		expect(verified.status).toBe("qualified");
		if (verified.status !== "qualified") return;
		const parent = privateParent();
		for (const change of ["missing", "altered"] as const) {
			const copy = next(`blob-${change}`);
			cpSync(source, copy, { recursive: true });
			const file = join(copy, "capture", "blobs", key.keyId, verified.candidate.archive.digest.value);
			if (change === "missing") rmSync(file);
			else writeFileSync(file, "substituted");
			expect(materializeVerifiedInitialCheckpointV0(copy, out, key, parent).status).toBe("refused");
		}
		const wrongKey = endoDigestKeyV0(randomBytes(32), "wrong-domain");
		expect(materializeVerifiedInitialCheckpointV0(source, out, wrongKey, parent).status).toBe("refused");
		expect(
			readFileSync(join(source, "capture", "blobs", key.keyId, verified.candidate.archive.digest.value)),
		).toEqual(Buffer.from(archiveBytes(source, out)));
	});

	it("refuses unsafe archive versions, paths and links through the verified reader", async () => {
		const source = recorded.completes!;
		const out = await replay(source);
		const parent = privateParent();
		const baseline = archiveBytes(source, out);
		const original = JSON.parse(Buffer.from(baseline).toString("utf8")) as Record<string, unknown>;
		const variants = [
			{ name: "malformed", bytes: Buffer.from("not-json") },
			{
				name: "unsupported",
				bytes: Buffer.from(canonicalEndoJsonV0({ ...original, schemaVersion: "endo.workspace-archive.v9" })),
			},
			{
				name: "unsafe-path",
				bytes: Buffer.from(
					canonicalEndoJsonV0({ ...original, entries: [{ path: "../escape", type: "directory", mtimeMs: 1 }] }),
				),
			},
			{
				name: "outward-link",
				bytes: Buffer.from(
					canonicalEndoJsonV0({
						...original,
						entries: [{ path: "work/link", type: "symlink", target: "/tmp/outside", mtimeMs: 1 }],
					}),
				),
			},
			{
				name: "special-entry",
				bytes: Buffer.from(
					canonicalEndoJsonV0({ ...original, entries: [{ path: "work/pipe", type: "fifo", mtimeMs: 1 }] }),
				),
			},
		];
		for (const variant of variants) {
			const copy = next(variant.name);
			cpSync(source, copy, { recursive: true });
			const ref = createEndoBlobStoreV0(endoCaptureRootV0(copy), key).put(variant.bytes);
			rewriteCapture(copy, (events) => {
				const snapshot = events.find((event) => event.kind === "capture.workspace-snapshot")!;
				(snapshot.payload as { archive: unknown }).archive = { digest: ref.digest, bytes: ref.bytes };
			});
			expect(materializeVerifiedInitialCheckpointV0(copy, out, key, parent).status, variant.name).toBe("refused");
		}
		expect(existsSync(join(parent, "escape"))).toBe(false);
		expect((await import("node:fs")).readdirSync(parent)).toEqual([]);
	});

	it("refuses symlinked, shared, store-internal and non-directory output parents without changing them", async () => {
		const source = recorded.completes!;
		const out = await replay(source);
		const parent = privateParent();
		const link = next("output-link");
		symlinkSync(parent, link);
		const shared = next("shared-output");
		mkdirSync(shared, { mode: 0o755 });
		chmodSync(shared, 0o755);
		const file = next("output-file");
		writeFileSync(file, "untouched");
		for (const unsafe of [link, shared, file, source, out, join(source, "capture")])
			expect(materializeVerifiedInitialCheckpointV0(source, out, key, unsafe).status, unsafe).toBe("refused");
		expect(readFileSync(file, "utf8")).toBe("untouched");
		expect((await import("node:fs")).readdirSync(parent)).toEqual([]);
	});

	it("refuses an output parent inside the physical recorded scratch root reached through a symlink alias", async () => {
		const physicalBase = next("physical-scratch-base");
		mkdirSync(physicalBase, { mode: 0o700 });
		const alias = next("scratch-alias");
		symlinkSync(physicalBase, alias);
		const source = next("aliased-source");
		const localProxy = await startEndoRecordingProxyV0({ upstream: new URL(upstream.baseUrl).origin, log: null });
		try {
			await recordPiCassetteSessionV0({
				scenario: scenarios.completes!,
				pi: install.bin,
				provider: "fake",
				model: "fake-1",
				proxy: localProxy,
				store: source,
				scratchRoot: join(alias, "scratch"),
				keySource,
				evidenceFrom: null,
				timeoutMs: 20_000,
			});
		} finally {
			await localProxy.close();
		}
		const out = await replay(source);
		expect(readVerifiedCheckpointCandidateV0(source, out, key).status).toBe("qualified");
		mkdirSync(join(physicalBase, "scratch"), { mode: 0o700 });
		const outputParent = mkdtempSync(join(physicalBase, "scratch", "output-"));
		expect(materializeVerifiedInitialCheckpointV0(source, out, key, outputParent)).toMatchObject({
			status: "refused",
			reason: "unsafe-output-parent",
		});
		expect((await import("node:fs")).readdirSync(outputParent)).toEqual([]);
	});
});
