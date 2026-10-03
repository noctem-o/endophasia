// Phase 12 — storage/: the durable append store. Frame log (torn tails, corrupt frames,
// strict truncateTo), the content-addressed artifact store, the durable event store
// (recovery, sealing, identical reopen), and the durable evidence ledger (meta identity,
// snapshot compaction, tamper refusal). Every hostile case is a byte-level attack on the
// files under a fresh temp dir; the stores never repair, they refuse or seal.
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoArtifactV0, EndoCandidateV0, EndoExperimentRecordV0, EndoMutationV0 } from "../protocol/evolution.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoArtifactStoreV0, sha256HexOfBytesV0 } from "../storage/artifacts.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { createEndoDurableEvidenceLedgerV0 } from "../storage/ledger.ts";
import { createEndoFrameLogV0 } from "../storage/log.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Append raw bytes to a file, simulating a torn write or a hostile edit. */
function rawAppend(file: string, bytes: Uint8Array): void {
	const fd = openSync(file, "a");
	try {
		writeSync(fd, Buffer.from(bytes));
	} finally {
		closeSync(fd);
	}
}
/** Flip one byte at an absolute offset. */
function flipByte(file: string, offset: number): void {
	const buffer = readFileSync(file);
	buffer[offset] = (buffer[offset]! + 1) % 256;
	writeFileSync(file, buffer);
}
/** The offset where frame 1 (0-based index `i`) begins, reading the lengths from the file. */
function frameStart(file: string, i: number): number {
	const buffer = readFileSync(file);
	let offset = 0;
	for (let n = 0; n < i; n += 1) {
		offset += 4 + buffer.readUInt32BE(offset) + 32;
	}
	return offset;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function event(id: string, sequence: number): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id,
		kind: "session.started",
		source: "runtime-fact",
		sequence,
		at: "2026-10-02T11:00:00Z",
		coordinates: { sessionId: "endo.session.s1", runId: "endo.run.r1" },
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: { lane: "main" },
	};
}

const EVENT_IDS = ["endo.event.s1", "endo.event.s2", "endo.event.s3"] as const;
const RECORD_ID = "endo.evidence.record-1";

// ---------------------------------------------------------------------------
// Evidence records for the ledger
// ---------------------------------------------------------------------------

const EXPERIMENT: EndoExperimentRecordV0 = { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-1" };
const LEDGER_ID = "endo.evidence.ledger-1";

const ARTIFACT: EndoArtifactV0 = (() => {
	const content = { text: "prompt v1" };
	return {
		schemaVersion: "endo.artifact.v0",
		id: "endo.evidence.art-1",
		kind: "policy.prompt",
		digest: sha256HexV0(canonicalEndoJsonV0(content)),
		content,
	};
})();

const MUTATION: EndoMutationV0 = {
	schemaVersion: "endo.mutation.v0",
	id: "endo.evidence.mut-1",
	component: "policy.prompt",
	operation: "replace",
	artifactId: "endo.evidence.art-1",
};

const CANDIDATE: EndoCandidateV0 = {
	schemaVersion: "endo.candidate.v0",
	id: "endo.candidate.c1",
	mutations: ["endo.evidence.mut-1"],
};

const CANDIDATE_2: EndoCandidateV0 = {
	schemaVersion: "endo.candidate.v0",
	id: "endo.candidate.c2",
	mutations: ["endo.evidence.mut-1"],
};

function seedLedger(ledger: ReturnType<typeof createEndoDurableEvidenceLedgerV0>): void {
	ledger.append(ARTIFACT);
	ledger.append(MUTATION);
	ledger.append(CANDIDATE);
}

describe("storage/log.ts — the durable frame log", () => {
	it("round-trips frames in order, one write per append, counting from one", () => {
		const file = join(tempDir("endo-log-"), "a.log");
		const log = createEndoFrameLogV0(file);
		const payloads = [Buffer.from("first"), Buffer.alloc(0), Buffer.from("third-payload")];
		for (const [index, payload] of payloads.entries()) expect(log.append(payload)).toBe(index + 1);
		expect(log.length).toBe(3);
		const { frames, truncated, corruptAt } = log.read();
		expect(truncated).toBe(false);
		expect(corruptAt).toBeNull();
		expect(frames).toHaveLength(3);
		for (let i = 0; i < payloads.length; i += 1) expect(Buffer.from(frames[i]!)).toEqual(payloads[i]!);
	});

	it("reads a missing file as empty, and a missing parent as empty too", () => {
		const dir = tempDir("endo-log-missing-");
		const log = createEndoFrameLogV0(join(dir, "nested", "absent.log"));
		expect(log.read()).toEqual({ frames: [], truncated: false, corruptAt: null });
		expect(log.length).toBe(0);
	});

	it("detects a torn tail, and truncateTo recovers it and appending continues", () => {
		const file = join(tempDir("endo-log-torn-"), "a.log");
		const log = createEndoFrameLogV0(file);
		log.append(Buffer.from("one"));
		log.append(Buffer.from("two"));
		rawAppend(file, Buffer.from("torn-tail-bytes"));
		const torn = log.read();
		expect(torn.truncated).toBe(true);
		expect(torn.corruptAt).toBeNull();
		expect(torn.frames).toHaveLength(2);
		log.truncateTo(2);
		const clean = log.read();
		expect(clean.truncated).toBe(false);
		expect(clean.corruptAt).toBeNull();
		expect(clean.frames).toHaveLength(2);
		expect(log.append(Buffer.from("three"))).toBe(3);
		expect(log.length).toBe(3);
	});

	it("reports the first corrupted frame by 1-based index and serves the valid prefix", () => {
		const file = join(tempDir("endo-log-corrupt-"), "a.log");
		const log = createEndoFrameLogV0(file);
		log.append(Buffer.from("alpha-alpha"));
		log.append(Buffer.from("beta-beta-beta"));
		log.append(Buffer.from("gamma"));
		flipByte(file, frameStart(file, 1) + 4 + 1);
		const { frames, truncated, corruptAt } = log.read();
		expect(truncated).toBe(false);
		expect(corruptAt).toBe(2);
		expect(frames).toHaveLength(1);
		expect(Buffer.from(frames[0]!)).toEqual(Buffer.from("alpha-alpha"));
	});

	it("a corrupted first frame leaves an empty valid prefix", () => {
		const file = join(tempDir("endo-log-corrupt1-"), "a.log");
		const log = createEndoFrameLogV0(file);
		log.append(Buffer.from("alpha"));
		log.append(Buffer.from("beta"));
		flipByte(file, 4 + 1);
		const { frames, truncated, corruptAt } = log.read();
		expect(truncated).toBe(false);
		expect(corruptAt).toBe(1);
		expect(frames).toHaveLength(0);
	});

	it("a corrupted length prefix is never read as a valid frame", () => {
		const file = join(tempDir("endo-log-length-"), "a.log");
		const log = createEndoFrameLogV0(file);
		log.append(Buffer.from("hello-world-1"));
		const buffer = readFileSync(file);
		buffer.writeUInt32BE(buffer.readUInt32BE(0) + 1, 0);
		writeFileSync(file, buffer);
		const report = log.read();
		expect(report.frames).toHaveLength(0);
		expect(report.truncated || report.corruptAt !== null).toBe(true);
	});

	it("truncateTo is strict: non-integer, out of range, and never past a corrupt frame", () => {
		const file = join(tempDir("endo-log-truncate-"), "a.log");
		const log = createEndoFrameLogV0(file);
		log.append(Buffer.from("one"));
		log.append(Buffer.from("two"));
		expect(() => log.truncateTo(0.5)).toThrow(TypeError);
		expect(() => log.truncateTo(-1)).toThrow(TypeError);
		expect(() => log.truncateTo(3)).toThrow(TypeError);
		flipByte(file, frameStart(file, 1) + 4);
		expect(() => log.truncateTo(1)).toThrow(TypeError);
		{
			// A clean truncate rewrites the file atomically to exactly the kept frames.
			const file2 = join(tempDir("endo-log-truncate2-"), "b.log");
			const other = createEndoFrameLogV0(file2);
			other.append(Buffer.from("one"));
			other.append(Buffer.from("two"));
			const before = readFileSync(file2);
			other.truncateTo(1);
			expect(readFileSync(file2)).toEqual(before.subarray(0, 4 + 3 + 32));
		}
	});
});

describe("storage/artifacts.ts — the content-addressed artifact store", () => {
	it("puts content that verifies to its digest and reads it back", () => {
		const store = createEndoArtifactStoreV0(tempDir("endo-artifacts-"));
		const bytes = Buffer.from("artifact content");
		const digest = sha256HexOfBytesV0(bytes);
		expect(store.put(digest, bytes)).toEqual({ created: true });
		expect(Buffer.from(store.get(digest))).toEqual(bytes);
		expect(store.has(digest)).toBe(true);
	});

	it("re-put of the verified content is idempotent", () => {
		const store = createEndoArtifactStoreV0(tempDir("endo-artifacts-idem-"));
		const bytes = Buffer.from("artifact content");
		const digest = sha256HexOfBytesV0(bytes);
		store.put(digest, bytes);
		expect(store.put(digest, bytes)).toEqual({ created: false });
		expect(Buffer.from(store.get(digest))).toEqual(bytes);
	});

	it("rejects a put whose content does not hash to its digest", () => {
		const store = createEndoArtifactStoreV0(tempDir("endo-artifacts-mismatch-"));
		const bytes = Buffer.from("artifact content");
		const digest = sha256HexOfBytesV0(bytes);
		expect(() => store.put(digest, Buffer.from("other content"))).toThrow(TypeError);
		expect(() => store.put(sha256HexOfBytesV0(Buffer.from("x")), Buffer.from("y"))).toThrow(TypeError);
	});

	it("detects a tampered file on get and refuses the put", () => {
		const root = tempDir("endo-artifacts-tamper-");
		const store = createEndoArtifactStoreV0(root);
		const bytes = Buffer.from("artifact content");
		const digest = sha256HexOfBytesV0(bytes);
		store.put(digest, bytes);
		flipByte(join(root, "artifacts", digest), 0);
		expect(() => store.get(digest)).toThrow(TypeError);
		expect(store.has(digest)).toBe(false);
		expect(() => store.put(digest, bytes)).toThrow(TypeError);
	});

	it("get of a missing artifact throws and has is false", () => {
		const store = createEndoArtifactStoreV0(tempDir("endo-artifacts-missing-"));
		const digest = sha256HexOfBytesV0(Buffer.from("absent"));
		expect(() => store.get(digest)).toThrow(TypeError);
		expect(store.has(digest)).toBe(false);
	});

	it("rejects digests that are not 64 lowercase hex", () => {
		const store = createEndoArtifactStoreV0(tempDir("endo-artifacts-digest-"));
		const bytes = Buffer.from("artifact content");
		const digest = sha256HexOfBytesV0(bytes);
		expect(() => store.put(digest.toUpperCase(), bytes)).toThrow(TypeError);
		expect(() => store.put(digest.slice(0, 63), bytes)).toThrow(TypeError);
		expect(() => store.get("NOPE")).toThrow(TypeError);
	});

	it("lists digests ascending, and a missing directory lists empty", () => {
		const store = createEndoArtifactStoreV0(tempDir("endo-artifacts-list-"));
		const pairs = ["content-a", "content-b", "content-c"].map((text) => ({
			text,
			digest: sha256HexOfBytesV0(Buffer.from(text)),
		}));
		const sorted = [...pairs].sort((a, b) => a.digest.localeCompare(b.digest));
		for (const { text, digest } of sorted) store.put(digest, Buffer.from(text));
		expect(store.list()).toEqual(sorted.map((pair) => pair.digest));
		expect(createEndoArtifactStoreV0(join(tempDir("endo-artifacts-empty-"), "absent")).list()).toEqual([]);
	});
});

describe("storage/event-store.ts — the durable event store", () => {
	const logFile = (root: string) => join(root, "events", "events.log");

	it("reopens with the identical page and record, and rejects duplicates and invalid events", () => {
		const root = tempDir("endo-events-");
		const first = createEndoDurableEventStoreV0(root);
		expect(first.recovery()).toEqual({ recovered: false, discardedPartial: false, sealed: false, corruptAt: null });
		for (const [index, id] of EVENT_IDS.entries()) first.ingest(event(id, index + 1));
		expect(first.length).toBe(3);
		expect(() => first.ingest(event("endo.event.s1", 4))).toThrow(TypeError);
		expect(() => first.ingest({ ...event("endo.event.s9", 9), kind: "not-a-kind" })).toThrow(TypeError);
		const pageBefore = canonicalEndoJsonV0(first.page());
		const recordBefore = canonicalEndoJsonV0(first.record(RECORD_ID));
		first.close();
		const second = createEndoDurableEventStoreV0(root);
		expect(second.recovery()).toEqual({ recovered: false, discardedPartial: false, sealed: false, corruptAt: null });
		expect(second.length).toBe(3);
		expect(canonicalEndoJsonV0(second.page())).toBe(pageBefore);
		expect(canonicalEndoJsonV0(second.record(RECORD_ID))).toBe(recordBefore);
	});

	it("pages by cursor and limit", () => {
		const root = tempDir("endo-events-page-");
		const store = createEndoDurableEventStoreV0(root);
		for (const [index, id] of EVENT_IDS.entries()) store.ingest(event(id, index + 1));
		const first = store.page({ limit: 2 });
		expect(first.events.map((value) => value.id)).toEqual(["endo.event.s1", "endo.event.s2"]);
		expect(first.nextAfterSequence).toBe(2);
		const second = store.page({ afterSequence: first.nextAfterSequence });
		expect(second.events.map((value) => value.id)).toEqual(["endo.event.s3"]);
		expect(second.nextAfterSequence).toBe(3);
	});

	it("recovers a torn tail and keeps appending", () => {
		const root = tempDir("endo-events-torn-");
		const first = createEndoDurableEventStoreV0(root);
		first.ingest(event("endo.event.s1", 1));
		first.ingest(event("endo.event.s2", 2));
		first.close();
		rawAppend(logFile(root), Buffer.from("torn-tail-bytes"));
		const second = createEndoDurableEventStoreV0(root);
		expect(second.recovery()).toEqual({ recovered: true, discardedPartial: true, sealed: false, corruptAt: null });
		expect(second.length).toBe(2);
		second.ingest(event("endo.event.s3", 3));
		expect(second.length).toBe(3);
	});

	it("seals on a corrupted frame, keeps the valid prefix readable, and disables append", () => {
		const root = tempDir("endo-events-sealed-");
		const first = createEndoDurableEventStoreV0(root);
		first.ingest(event("endo.event.s1", 1));
		first.ingest(event("endo.event.s2", 2));
		first.close();
		flipByte(logFile(root), frameStart(logFile(root), 1) + 4 + 1);
		const second = createEndoDurableEventStoreV0(root);
		expect(second.recovery()).toEqual({ recovered: false, discardedPartial: false, sealed: true, corruptAt: 2 });
		expect(second.length).toBe(1);
		expect(second.page().events.map((value) => value.id)).toEqual(["endo.event.s1"]);
		expect(second.record(RECORD_ID).events).toHaveLength(1);
		expect(() => second.ingest(event("endo.event.s3", 3))).toThrow(/sealed/);
	});

	it("seals at frame one with an empty prefix", () => {
		const root = tempDir("endo-events-sealed1-");
		const first = createEndoDurableEventStoreV0(root);
		first.ingest(event("endo.event.s1", 1));
		first.close();
		flipByte(logFile(root), 4 + 1);
		const second = createEndoDurableEventStoreV0(root);
		expect(second.recovery()).toEqual({ recovered: false, discardedPartial: false, sealed: true, corruptAt: 1 });
		expect(second.length).toBe(0);
		expect(() => second.ingest(event("endo.event.s2", 2))).toThrow(/sealed/);
	});

	it("refuses to open a log whose frames duplicate ids, violate the event rules, or do not decode", () => {
		const clean = (prefix: string) => {
			const root = tempDir(prefix);
			const store = createEndoDurableEventStoreV0(root);
			store.ingest(event("endo.event.s1", 1));
			store.close();
			return root;
		};
		const duplicate = clean("endo-events-dup-");
		createEndoFrameLogV0(logFile(duplicate)).append(Buffer.from(canonicalEndoJsonV0(event("endo.event.s1", 1))));
		expect(() => createEndoDurableEventStoreV0(duplicate)).toThrow(TypeError);
		const invalid = clean("endo-events-invalid-");
		createEndoFrameLogV0(logFile(invalid)).append(
			Buffer.from(JSON.stringify({ ...event("endo.event.s2", 2), id: "endo.session.s1" })),
		);
		expect(() => createEndoDurableEventStoreV0(invalid)).toThrow(TypeError);
		const undecodable = clean("endo-events-binary-");
		createEndoFrameLogV0(logFile(undecodable)).append(Buffer.from([0xff, 0xfe]));
		expect(() => createEndoDurableEventStoreV0(undecodable)).toThrow(/does not decode as UTF-8 JSON/);
	});

	it("every operation throws after close", () => {
		const root = tempDir("endo-events-closed-");
		const store = createEndoDurableEventStoreV0(root);
		store.ingest(event("endo.event.s1", 1));
		store.close();
		expect(() => store.length).toThrow(TypeError);
		expect(() => store.ingest(event("endo.event.s2", 2))).toThrow(TypeError);
		expect(() => store.page()).toThrow(TypeError);
		expect(() => store.record(RECORD_ID)).toThrow(TypeError);
		expect(() => store.recovery()).toThrow(TypeError);
	});
});

describe("storage/ledger.ts — the durable evidence ledger", () => {
	const logFile = (root: string) => join(root, "ledger", "ledger.log");
	const metaFile = (root: string) => join(root, "ledger", "ledger.meta.json");
	const snapshotFile = (root: string) => join(root, "ledger", "ledger.snapshot.json");

	it("appends records, reopens by log replay, and appends on", () => {
		const root = tempDir("endo-ledger-");
		const first = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		expect(first.replay()).toEqual({ layer: "empty", entryCount: 0, fromSnapshot: false, verifiedEntries: [] });
		seedLedger(first);
		expect(first.length).toBe(3);
		expect(first.record).toEqual(EXPERIMENT);
		const before = canonicalEndoJsonV0(first.ledger());
		first.close();
		const second = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		expect(second.replay()).toEqual({
			layer: "log",
			entryCount: 3,
			fromSnapshot: false,
			verifiedEntries: [
				{
					schemaVersion: "endo.evidence-ledger-entry.v0",
					sequence: 1,
					kind: "artifact",
					recordId: "endo.evidence.art-1",
				},
				{
					schemaVersion: "endo.evidence-ledger-entry.v0",
					sequence: 2,
					kind: "mutation",
					recordId: "endo.evidence.mut-1",
				},
				{
					schemaVersion: "endo.evidence-ledger-entry.v0",
					sequence: 3,
					kind: "candidate",
					recordId: "endo.candidate.c1",
				},
			],
		});
		expect(canonicalEndoJsonV0(second.ledger())).toBe(before);
		expect(second.append(CANDIDATE_2).sequence).toBe(4);
		expect(second.length).toBe(4);
	});

	it("refuses to reopen under a different id or experiment", () => {
		const root = tempDir("endo-ledger-identity-");
		const first = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		first.append(ARTIFACT);
		first.close();
		expect(() => createEndoDurableEvidenceLedgerV0(root, "endo.evidence.other", EXPERIMENT)).toThrow(
			/identity mismatch/,
		);
		expect(() =>
			createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, { ...EXPERIMENT, id: "endo.experiment.exp-2" }),
		).toThrow(/identity mismatch/);
	});

	it("applies the in-memory rules through the durable door", () => {
		const ledger = createEndoDurableEvidenceLedgerV0(
			tempDir("endo-ledger-rules-"),
			"endo.evidence.ledger-2",
			EXPERIMENT,
		);
		expect(() => ledger.append({ ...MUTATION, artifactId: "endo.evidence.missing" })).toThrow(TypeError);
		ledger.append(ARTIFACT);
		expect(() => ledger.append(ARTIFACT)).toThrow(TypeError);
		expect(() => ledger.append({ schemaVersion: "endo.unknown.v0", id: "endo.evidence.x" })).toThrow(
			/closed evidence record kinds/,
		);
		expect(() =>
			ledger.append({
				schemaVersion: "endo.artifact.v0",
				id: "endo.evidence.art-9",
				kind: "policy.prompt",
				digest: "zz",
			}),
		).toThrow(/not a valid/);
	});

	it("recovers a torn tail and keeps appending", () => {
		const root = tempDir("endo-ledger-torn-");
		const first = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		seedLedger(first);
		first.close();
		rawAppend(logFile(root), Buffer.from("torn-tail-bytes"));
		const second = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		expect(second.replay()).toMatchObject({ layer: "log", entryCount: 3 });
		expect(second.append(CANDIDATE_2).sequence).toBe(4);
	});

	it("seals on a corrupted frame and keeps the verified prefix materialised", () => {
		const root = tempDir("endo-ledger-sealed-");
		const first = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		seedLedger(first);
		first.close();
		flipByte(logFile(root), frameStart(logFile(root), 1) + 4 + 1);
		const second = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		expect(second.replay()).toMatchObject({ layer: "log", entryCount: 1, fromSnapshot: false });
		expect(second.ledger().entries).toHaveLength(1);
		expect(() => second.append(ARTIFACT)).toThrow(/sealed/);
	});

	it("a snapshot plus appends reopens as snapshot+log", () => {
		const root = tempDir("endo-ledger-snapshot-");
		const first = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		seedLedger(first);
		const snap = first.snapshot();
		expect(snap.entriesCount).toBe(3);
		expect(snap.digest).toMatch(/^[0-9a-f]{64}$/);
		first.append(CANDIDATE_2);
		const before = canonicalEndoJsonV0(first.ledger());
		first.close();
		const second = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		expect(second.replay()).toMatchObject({ layer: "snapshot+log", entryCount: 4, fromSnapshot: true });
		expect(canonicalEndoJsonV0(second.ledger())).toBe(before);
	});

	it("a snapshot-only log reopens as snapshot", () => {
		const root = tempDir("endo-ledger-snapshot-only-");
		const first = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		seedLedger(first);
		first.snapshot();
		const before = canonicalEndoJsonV0(first.ledger());
		first.close();
		const second = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		expect(second.replay()).toMatchObject({ layer: "snapshot", entryCount: 3, fromSnapshot: true });
		expect(canonicalEndoJsonV0(second.ledger())).toBe(before);
	});

	it("refuses a snapshot whose digest, entriesCount, entries, or coverage is wrong", () => {
		const base = (prefix: string, logEntries: number) => {
			const root = tempDir(prefix);
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			for (const record of [ARTIFACT, MUTATION, CANDIDATE].slice(0, logEntries)) ledger.append(record);
			ledger.close();
			return { root, ledger };
		};
		// 1. A snapshot whose digest does not verify.
		const badDigest = base("endo-ledger-snap-digest-", 3);
		{
			const ledger = createEndoDurableEvidenceLedgerV0(badDigest.root, LEDGER_ID, EXPERIMENT);
			ledger.snapshot();
			ledger.close();
			const envelope = JSON.parse(readFileSync(snapshotFile(badDigest.root), "utf8")) as {
				digest: string;
				entriesCount: number;
				ledger: unknown;
			};
			writeFileSync(snapshotFile(badDigest.root), JSON.stringify({ ...envelope, digest: "0".repeat(64) }));
			expect(() => createEndoDurableEvidenceLedgerV0(badDigest.root, LEDGER_ID, EXPERIMENT)).toThrow(
				/does not verify/,
			);
		}
		// 2. A snapshot whose entriesCount disagrees.
		const badCount = base("endo-ledger-snap-count-", 3);
		{
			const ledger = createEndoDurableEvidenceLedgerV0(badCount.root, LEDGER_ID, EXPERIMENT);
			ledger.snapshot();
			ledger.close();
			const envelope = JSON.parse(readFileSync(snapshotFile(badCount.root), "utf8")) as {
				digest: string;
				entriesCount: number;
				ledger: unknown;
			};
			writeFileSync(snapshotFile(badCount.root), JSON.stringify({ ...envelope, entriesCount: 2 }));
			expect(() => createEndoDurableEvidenceLedgerV0(badCount.root, LEDGER_ID, EXPERIMENT)).toThrow(
				/entriesCount disagrees/,
			);
		}
		// 3. A snapshot whose entries disagree with the log (digest re-forged over the tamper).
		const badEntry = base("endo-ledger-snap-entry-", 3);
		{
			const live = createEndoDurableEvidenceLedgerV0(badEntry.root, LEDGER_ID, EXPERIMENT);
			const ledgerValue = live.ledger();
			live.close();
			const tampered = {
				...ledgerValue,
				entries: ledgerValue.entries.map((entry, index) =>
					index === 1 ? { ...entry, recordId: "endo.evidence.other" } : entry,
				),
			};
			writeFileSync(
				snapshotFile(badEntry.root),
				JSON.stringify({ digest: sha256HexV0(canonicalEndoJsonV0(tampered)), entriesCount: 3, ledger: tampered }),
			);
			expect(() => createEndoDurableEvidenceLedgerV0(badEntry.root, LEDGER_ID, EXPERIMENT)).toThrow(
				/disagrees with the log/,
			);
		}
		// 4. A snapshot that covers more entries than the log holds.
		const badCoverage = base("endo-ledger-snap-coverage-", 1);
		{
			const full = createEndoDurableEvidenceLedgerV0(
				tempDir("endo-ledger-snap-coverage-src-"),
				LEDGER_ID,
				EXPERIMENT,
			);
			seedLedger(full);
			const ledgerValue = full.ledger();
			writeFileSync(
				snapshotFile(badCoverage.root),
				JSON.stringify({
					digest: sha256HexV0(canonicalEndoJsonV0(ledgerValue)),
					entriesCount: 3,
					ledger: ledgerValue,
				}),
			);
			expect(() => createEndoDurableEvidenceLedgerV0(badCoverage.root, LEDGER_ID, EXPERIMENT)).toThrow(
				/covers more entries/,
			);
		}
	});

	it("refuses a corrupt meta file", () => {
		const root = tempDir("endo-ledger-meta-");
		const first = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		first.append(ARTIFACT);
		first.close();
		const meta = readFileSync(metaFile(root), "utf8");
		writeFileSync(metaFile(root), meta.replace(`"endo.evidence.ledger-1"`, `"endo.evidence.ledger-2"`));
		expect(() => createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT)).toThrow(/does not verify/);
	});

	it("refuses a log frame that does not decode as JSON", () => {
		const root = tempDir("endo-ledger-binary-");
		const first = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		first.append(ARTIFACT);
		first.close();
		createEndoFrameLogV0(logFile(root)).append(Buffer.from([0xff, 0xfe]));
		expect(() => createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT)).toThrow(
			/does not decode as UTF-8 JSON/,
		);
	});

	it("every operation throws after close", () => {
		const root = tempDir("endo-ledger-closed-");
		const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
		ledger.append(ARTIFACT);
		ledger.close();
		expect(() => ledger.length).toThrow(TypeError);
		expect(() => ledger.append(MUTATION)).toThrow(TypeError);
		expect(() => ledger.ledger()).toThrow(TypeError);
		expect(() => ledger.snapshot()).toThrow(TypeError);
		expect(() => ledger.replay()).toThrow(TypeError);
	});
});
