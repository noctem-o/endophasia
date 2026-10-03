// Phase 12 — the full-stack integration harness over the durable substrate. Three scenarios:
// the golden path (record, compact, close, reopen, replay, verify — content-identical
// canonical-JSON strings — plus the CLI surface), the adversarial path (torn tails, digest
// mismatches, tampered artifacts, and undecodable frames are never repaired), and the
// persisted e2e path (a crash with torn tails on both logs, recovery, replay, and continued
// appends across a real close/reopen boundary).
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ledgerCommand, statusCommand } from "../cli/commands.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoArtifactV0, EndoCandidateV0, EndoExperimentRecordV0 } from "../protocol/evolution.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoArtifactStoreV0, sha256HexOfBytesV0 } from "../storage/artifacts.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { createEndoDurableEvidenceLedgerV0 } from "../storage/ledger.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run one command, capturing its single canonical-JSON stdout document (one console.log, multi-line). */
let logs: string[] = [];
function run(command: (argv: readonly string[]) => void, ...argv: string[]): string {
	logs = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		logs.push(String(value));
	});
	command(argv);
	vi.restoreAllMocks();
	expect(logs).toHaveLength(1);
	return logs[0]!;
}

function event(id: string, sequence: number): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id,
		kind: "session.started",
		source: "runtime-fact",
		sequence,
		at: "2026-10-03T09:00:00Z",
		coordinates: { sessionId: "endo.session.s1", runId: "endo.run.r1" },
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: { lane: "main" },
	};
}

const EXPERIMENT: EndoExperimentRecordV0 = { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-1" };
const LEDGER_ID = "endo.evidence.ledger-1";

const CANDIDATE: EndoCandidateV0 = { schemaVersion: "endo.candidate.v0", id: "endo.candidate.c1", mutations: [] };

function artifactOf(id: string, text: string): EndoArtifactV0 {
	const content = { text };
	return {
		schemaVersion: "endo.artifact.v0",
		id,
		kind: "policy.prompt",
		digest: sha256HexV0(canonicalEndoJsonV0(content)),
		content,
	};
}

/** One frame as the log writes it: `<u32be len><payload><sha256 len+payload>`. */
function framedPayload(payload: Buffer): Buffer {
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length, 0);
	const digest = createHash("sha256")
		.update(Buffer.concat([header, payload]))
		.digest();
	return Buffer.concat([header, payload, digest]);
}

/** Append raw bytes to a file (torn-tail simulation). */
function rawAppend(file: string, bytes: Uint8Array): void {
	const fd = openSync(file, "a");
	try {
		writeSync(fd, Buffer.from(bytes));
	} finally {
		closeSync(fd);
	}
}

/** Flip one byte at an absolute offset (digest-mismatch simulation). */
function flipByte(file: string, offset: number): void {
	const buffer = readFileSync(file);
	buffer[offset] = (buffer[offset]! + 1) % 256;
	writeFileSync(file, buffer);
}

describe("integration — golden path: record, compact, close, reopen, replay, verify", () => {
	it("survives a real close/reopen boundary with content-identical canonical JSON", () => {
		const root = tempDir("endo-ig-golden-");

		// -- session 1: record everything --------------------------------------
		const recordBefore = (() => {
			const store = createEndoDurableEventStoreV0(root);
			store.ingest(event("endo.event.g1", 1));
			store.ingest(event("endo.event.g2", 2));
			store.ingest(event("endo.event.g3", 3));
			const record = store.record("endo.evidence.rec-1", { sessionId: "endo.session.s1" });
			store.close();
			return canonicalEndoJsonV0(record);
		})();

		const ledgerBefore = (() => {
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			ledger.append(artifactOf("endo.evidence.art-1", "prompt v1"));
			ledger.append(CANDIDATE);
			ledger.append(artifactOf("endo.evidence.art-2", "prompt v2"));
			const compacted = ledger.snapshot();
			const value = canonicalEndoJsonV0(ledger.ledger());
			ledger.close();
			return { value, compacted };
		})();

		const payloadOne = Buffer.from("candidate source v1");
		const payloadTwo = Buffer.from("candidate source v2");
		const digestOne = sha256HexOfBytesV0(payloadOne);
		const digestTwo = sha256HexOfBytesV0(payloadTwo);
		{
			const artifacts = createEndoArtifactStoreV0(root);
			expect(artifacts.put(digestOne, payloadOne)).toEqual({ created: true });
			expect(artifacts.put(digestTwo, payloadTwo)).toEqual({ created: true });
		}

		// -- the CLI sees the compacted state -----------------------------------
		const status = JSON.parse(run(statusCommand, root)) as {
			events: { length: number };
			ledger: { layer: string; entryCount: number; fromSnapshot: boolean; verifiedEntries: unknown[] };
			artifacts: string[];
		};
		expect(status.events.length).toBe(3);
		expect(status.ledger.layer).toBe("snapshot");
		expect(status.ledger.entryCount).toBe(3);
		expect(status.ledger.fromSnapshot).toBe(true);
		expect(status.ledger.verifiedEntries).toHaveLength(3);
		expect(status.artifacts).toEqual([digestOne, digestTwo].sort());

		// -- session 2: everything reopens content-identically -------------------
		const recordAfter = (() => {
			const store = createEndoDurableEventStoreV0(root);
			expect(store.length).toBe(3);
			expect(store.recovery()).toMatchObject({
				recovered: false,
				discardedPartial: false,
				discarded: null,
				sealed: false,
				corruptAt: null,
			});
			const record = store.record("endo.evidence.rec-1", { sessionId: "endo.session.s1" });
			store.close();
			return canonicalEndoJsonV0(record);
		})();
		expect(recordAfter).toBe(recordBefore);

		const replay = (() => {
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			const report = ledger.replay();
			const value = canonicalEndoJsonV0(ledger.ledger());
			ledger.close();
			return { report, value };
		})();
		expect(replay.report.layer).toBe("snapshot");
		expect(replay.report.entryCount).toBe(3);
		expect(replay.report.fromSnapshot).toBe(true);
		expect(replay.report.verifiedEntries).toHaveLength(3);
		expect(replay.report.verifiedEntries[0]).toEqual({
			schemaVersion: "endo.evidence-ledger-entry.v0",
			sequence: 1,
			kind: "artifact",
			recordId: "endo.evidence.art-1",
		});
		expect(ledgerBefore.compacted.entriesCount).toBe(3);

		const artifactsAfter = (() => {
			const artifacts = createEndoArtifactStoreV0(root);
			const one = artifacts.get(digestOne);
			const two = artifacts.get(digestTwo);
			return {
				one: Buffer.from(one).toString("utf8"),
				two: Buffer.from(two).toString("utf8"),
				list: artifacts.list(),
			};
		})();
		expect(artifactsAfter.one).toBe("candidate source v1");
		expect(artifactsAfter.two).toBe("candidate source v2");
		expect(artifactsAfter.list).toEqual([digestOne, digestTwo].sort());

		// -- the CLI agrees with the in-process replay ----------------------------
		const cli = JSON.parse(run(ledgerCommand, root)) as {
			replay: { layer: string; entryCount: number; fromSnapshot: boolean; verifiedEntries: unknown[] };
			ledger: unknown;
		};
		expect(cli.replay.layer).toBe("snapshot");
		expect(cli.replay.entryCount).toBe(3);
		expect(cli.replay.fromSnapshot).toBe(true);
		expect(cli.replay.verifiedEntries).toHaveLength(3);
		expect(canonicalEndoJsonV0(cli.ledger)).toBe(ledgerBefore.value);
	});
});

describe("integration — adversarial: corruption is refused, never repaired", () => {
	it("recovers a torn event tail and keeps ingesting", () => {
		const root = tempDir("endo-ig-torn-");
		const logFile = join(root, "events", "events.log");
		{
			const store = createEndoDurableEventStoreV0(root);
			store.ingest(event("endo.event.t1", 1));
			store.ingest(event("endo.event.t2", 2));
			store.close();
		}
		const before = (() => {
			const store = createEndoDurableEventStoreV0(root);
			const value = canonicalEndoJsonV0(store.record("endo.evidence.rec-t"));
			store.close();
			return value;
		})();
		rawAppend(logFile, Buffer.from([0, 0, 0, 6, 1, 2, 3, 4, 5, 6]));
		{
			const store = createEndoDurableEventStoreV0(root);
			expect(store.recovery()).toMatchObject({
				recovered: true,
				discardedPartial: true,
				discarded: { bytes: 10, sha256: sha256HexOfBytesV0(Uint8Array.from([0, 0, 0, 6, 1, 2, 3, 4, 5, 6])) },
				sealed: false,
				corruptAt: null,
			});
			expect(store.length).toBe(2);
			store.ingest(event("endo.event.t3", 3));
			store.close();
		}
		const after = (() => {
			const store = createEndoDurableEventStoreV0(root);
			expect(store.recovery()).toMatchObject({
				recovered: false,
				discardedPartial: false,
				discarded: null,
				sealed: false,
				corruptAt: null,
			});
			expect(store.length).toBe(3);
			const value = canonicalEndoJsonV0(store.record("endo.evidence.rec-t"));
			store.close();
			return value;
		})();
		expect(canonicalEndoJsonV0(JSON.parse(after))).toContain("endo.event.t3");
		expect(before).not.toBe(after);
	});

	it("seals the event store when a complete frame fails verification", () => {
		const root = tempDir("endo-ig-sealed-");
		const logFile = join(root, "events", "events.log");
		{
			const store = createEndoDurableEventStoreV0(root);
			store.ingest(event("endo.event.s1", 1));
			store.ingest(event("endo.event.s2", 2));
			store.close();
		}
		flipByte(logFile, 8);
		const store = createEndoDurableEventStoreV0(root);
		expect(store.recovery()).toMatchObject({
			recovered: false,
			discardedPartial: false,
			discarded: null,
			sealed: true,
			corruptAt: 1,
		});
		expect(store.length).toBe(0);
		expect(() => store.ingest(event("endo.event.s3", 3))).toThrow(TypeError);
		expect(store.page({ limit: 10 }).events).toEqual([]);
		store.close();
	});

	it("seals the ledger when a later frame fails verification and keeps the valid prefix", () => {
		const root = tempDir("endo-ig-ledger-seal-");
		const logFile = join(root, "ledger", "ledger.log");
		const first = artifactOf("endo.evidence.a-1", "one");
		{
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			ledger.append(first);
			ledger.append(artifactOf("endo.evidence.a-2", "two"));
			ledger.close();
		}
		const frameOne = 4 + canonicalEndoJsonV0(first).length + 32;
		flipByte(logFile, frameOne + 8);
		const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		expect(ledger.replay()).toEqual({
			layer: "log",
			entryCount: 1,
			fromSnapshot: false,
			verifiedEntries: [
				{
					schemaVersion: "endo.evidence-ledger-entry.v0",
					sequence: 1,
					kind: "artifact",
					recordId: "endo.evidence.a-1",
				},
			],
		});
		expect(() => ledger.append(artifactOf("endo.evidence.a-3", "three"))).toThrow(TypeError);
		ledger.close();
	});

	it("refuses an undecodable event frame and an undecodable ledger frame at open", () => {
		const root = tempDir("endo-ig-undecodable-");
		const eventLog = join(root, "events", "events.log");
		const ledgerLog = join(root, "ledger", "ledger.log");
		{
			const store = createEndoDurableEventStoreV0(root);
			store.ingest(event("endo.event.u1", 1));
			store.close();
		}
		{
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			ledger.append(artifactOf("endo.evidence.u-1", "one"));
			ledger.close();
		}
		rawAppend(eventLog, framedPayload(Buffer.from("{}")));
		expect(() => createEndoDurableEventStoreV0(root)).toThrow(TypeError);
		rawAppend(ledgerLog, framedPayload(Buffer.from("not-json")));
		expect(() => createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT)).toThrow(TypeError);
	});

	it("refuses a tampered artifact on read and in has()", () => {
		const root = tempDir("endo-ig-artifact-");
		const artifacts = createEndoArtifactStoreV0(root);
		const payload = Buffer.from("candidate source v1");
		const digest = sha256HexOfBytesV0(payload);
		artifacts.put(digest, payload);
		flipByte(join(root, "artifacts", digest), 0);
		expect(() => artifacts.get(digest)).toThrow(TypeError);
		expect(artifacts.has(digest)).toBe(false);
	});
});

describe("integration — persisted e2e: crash, recover, replay, continue", () => {
	it("survives torn tails on both logs across a close/reopen boundary", () => {
		const root = tempDir("endo-ig-e2e-");
		const eventLog = join(root, "events", "events.log");
		const ledgerLog = join(root, "ledger", "ledger.log");

		// -- session 1 ----------------------------------------------------------
		const recordBefore = (() => {
			const store = createEndoDurableEventStoreV0(root);
			for (let index = 1; index <= 4; index += 1) store.ingest(event(`endo.event.p${index}`, index));
			const record = store.record("endo.evidence.rec-p", { sessionId: "endo.session.s1" });
			store.close();
			return canonicalEndoJsonV0(record);
		})();
		const ledgerBefore = (() => {
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			ledger.append(artifactOf("endo.evidence.p-1", "one"));
			ledger.append(CANDIDATE);
			ledger.append(artifactOf("endo.evidence.p-2", "two"));
			ledger.snapshot();
			const value = canonicalEndoJsonV0(ledger.ledger());
			ledger.close();
			return value;
		})();

		// -- the crash: both logs end mid-frame -----------------------------------
		rawAppend(eventLog, Buffer.from([0, 0, 1, 0, 2, 0]));
		rawAppend(ledgerLog, Buffer.from([0, 0, 0, 9, 1, 2]));

		// -- session 2: recover, verify content identity, continue ------------------
		const recovered = (() => {
			const store = createEndoDurableEventStoreV0(root);
			expect(store.recovery()).toMatchObject({
				recovered: true,
				discardedPartial: true,
				discarded: { bytes: 6, sha256: sha256HexOfBytesV0(Uint8Array.from([0, 0, 1, 0, 2, 0])) },
				sealed: false,
				corruptAt: null,
			});
			expect(store.length).toBe(4);
			const record = store.record("endo.evidence.rec-p", { sessionId: "endo.session.s1" });
			store.close();
			return canonicalEndoJsonV0(record);
		})();
		expect(recovered).toBe(recordBefore);

		const replayed = (() => {
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			expect(ledger.recovery()).toMatchObject({
				recovered: true,
				discarded: { bytes: 6, sha256: sha256HexOfBytesV0(Uint8Array.from([0, 0, 0, 9, 1, 2])) },
			});
			const report = ledger.replay();
			expect(report.layer).toBe("snapshot");
			expect(report.entryCount).toBe(3);
			expect(report.fromSnapshot).toBe(true);
			expect(report.verifiedEntries).toHaveLength(3);
			const value = canonicalEndoJsonV0(ledger.ledger());
			ledger.append(artifactOf("endo.evidence.p-3", "three"));
			ledger.close();
			return value;
		})();
		expect(replayed).toBe(ledgerBefore);

		// -- session 3: the continued ledger replays from snapshot plus log ---------
		const final = (() => {
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			const report = ledger.replay();
			const value = canonicalEndoJsonV0(ledger.ledger());
			ledger.close();
			return { report, value };
		})();
		expect(final.report.layer).toBe("snapshot+log");
		expect(final.report.entryCount).toBe(4);
		expect(final.report.fromSnapshot).toBe(true);
		expect(final.report.verifiedEntries).toHaveLength(4);
		expect(final.report.verifiedEntries[3]).toEqual({
			schemaVersion: "endo.evidence-ledger-entry.v0",
			sequence: 4,
			kind: "artifact",
			recordId: "endo.evidence.p-3",
		});
		expect(final.value).not.toBe(ledgerBefore);
		expect(final.value).toContain("endo.evidence.p-3");

		const cli = JSON.parse(run(ledgerCommand, root)) as {
			replay: { layer: string; entryCount: number; fromSnapshot: boolean };
		};
		expect(cli.replay.layer).toBe("snapshot+log");
		expect(cli.replay.entryCount).toBe(4);
		expect(cli.replay.fromSnapshot).toBe(true);
	});
});
