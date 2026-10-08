// Phase 12 — cli/: the thin commands over the durable substrate. Each test imports the
// command functions directly (no subprocess), captures the single canonical-JSON stdout
// line, and pins it exactly. Misuse is a TypeError with an operator-readable message;
// sealed stores, missing files, and invalid records are refused, never repaired.
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { artifactsCommand, eventsCommand, ingestCommand, ledgerCommand, statusCommand } from "../cli/commands.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoArtifactV0, EndoExperimentRecordV0 } from "../protocol/evolution.ts";
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

/** Run one command, capturing its single canonical-JSON stdout line. */
let logs: string[] = [];
function run(command: (argv: readonly string[]) => void, ...argv: string[]): string {
	logs = [];
	vi.spyOn(console, "log").mockImplementation((value: unknown) => {
		logs.push(String(value));
	});
	command(argv);
	expect(logs).toHaveLength(1);
	return logs[0]!;
}
afterEach(() => {
	vi.restoreAllMocks();
});

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

/** The recovery report of a clean read-only open (the reporting commands open every store read-only). */
const CLEAN_LOG_RECOVERY_V0 = {
	readOnly: true,
	truncated: false,
	tail: null,
	recovered: false,
	discarded: null,
	sealed: false,
	corruptAt: null,
};
const CLEAN_RECOVERY_V0 = { ...CLEAN_LOG_RECOVERY_V0, discardedPartial: false };

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

/** Write one JSON value to a new file under `dir`; returns the file path. */
function writeJson(dir: string, name: string, value: unknown): string {
	const file = join(dir, name);
	writeFileSync(file, JSON.stringify(value), "utf8");
	return file;
}
/** Append raw bytes to a file. */
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

function seedEvents(root: string, count: number): void {
	const store = createEndoDurableEventStoreV0(root);
	for (const [index] of Array.from({ length: count }).entries())
		store.ingest(event(`endo.event.c${index + 1}`, index + 1));
	store.close();
}

describe("cli/commands.ts — the thin commands over the durable substrate", () => {
	it("status reports an empty root with honest absence, and creates nothing in it", () => {
		const root = tempDir("endo-cli-status-empty-");
		const out = run(statusCommand, root);
		expect(out).toBe(canonicalEndoJsonV0({ events: { length: 0, recovery: CLEAN_RECOVERY_V0 }, artifacts: [] }));
		expect(readdirSync(root)).toEqual([]);
	});

	it("status reports the event log and the ledger layer after seeding", () => {
		const root = tempDir("endo-cli-status-");
		seedEvents(root, 2);
		{
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			ledger.append(ARTIFACT);
			ledger.close();
		}
		const out = run(statusCommand, root);
		expect(out).toBe(
			canonicalEndoJsonV0({
				events: { length: 2, recovery: CLEAN_RECOVERY_V0 },
				ledger: {
					layer: "log",
					entryCount: 1,
					fromSnapshot: false,
					verifiedEntries: [
						{
							schemaVersion: "endo.evidence-ledger-entry.v0",
							sequence: 1,
							kind: "artifact",
							recordId: "endo.evidence.art-1",
						},
					],
					recovery: CLEAN_LOG_RECOVERY_V0,
				},
				artifacts: [],
			}),
		);
	});

	it("events pages by limit and after-sequence, exactly like the in-memory store", () => {
		const root = tempDir("endo-cli-events-");
		seedEvents(root, 3);
		const first = run(eventsCommand, root, "--limit", "2");
		const page = JSON.parse(first) as { events: { id: string }[]; nextAfterSequence: number | null };
		expect(page.events.map((value) => value.id)).toEqual(["endo.event.c1", "endo.event.c2"]);
		expect(page.nextAfterSequence).toBe(2);
		const rest = JSON.parse(run(eventsCommand, root, "--after", "2")) as {
			events: { id: string }[];
			nextAfterSequence: number | null;
		};
		expect(rest.events.map((value) => value.id)).toEqual(["endo.event.c3"]);
		expect(rest.nextAfterSequence).toBe(3);
	});

	it("events refuses a non-integer limit, a flag with no value, and an unknown flag", () => {
		const root = tempDir("endo-cli-events-bad-");
		expect(() => run(eventsCommand, root, "--limit", "1.5")).toThrow(TypeError);
		expect(() => run(eventsCommand, root, "--limit")).toThrow(/needs a value/);
		expect(() => run(eventsCommand, root, "--bogus", "1")).toThrow(/unknown flag/);
	});

	it("ingest appends one event file and prints the stored event canonically", () => {
		const root = tempDir("endo-cli-ingest-");
		const dir = tempDir("endo-cli-ingest-files-");
		const file = writeJson(dir, "one.json", event("endo.event.c1", 1));
		const out = run(ingestCommand, root, file);
		expect(out).toBe(canonicalEndoJsonV0(event("endo.event.c1", 1)));
		const status = JSON.parse(run(statusCommand, root)) as { events: { length: number } };
		expect(status.events.length).toBe(1);
	});

	it("ingest refuses a missing file, a non-JSON file, and a duplicate id", () => {
		const root = tempDir("endo-cli-ingest-bad-");
		const dir = tempDir("endo-cli-ingest-bad-files-");
		expect(() => run(ingestCommand, root, join(dir, "absent.json"))).toThrow(/cannot read/);
		const notJson = join(dir, "not-json.json");
		writeFileSync(notJson, "not json", "utf8");
		expect(() => run(ingestCommand, root, notJson)).toThrow(/does not contain JSON/);
		const file = writeJson(dir, "one.json", event("endo.event.c1", 1));
		run(ingestCommand, root, file);
		expect(() => run(ingestCommand, root, file)).toThrow(/duplicate event id: endo.event.c1/);
	});

	it("ingest refuses a sealed store and reports the refusal", () => {
		const root = tempDir("endo-cli-ingest-sealed-");
		seedEvents(root, 2);
		flipByte(join(root, "events", "events.log"), 4);
		const dir = tempDir("endo-cli-ingest-sealed-files-");
		const file = writeJson(dir, "three.json", event("endo.event.c3", 3));
		expect(() => run(ingestCommand, root, file)).toThrow(/sealed/);
	});

	it("ledger refuses a root with no ledger and reports the seeded one exactly", () => {
		expect(() => run(ledgerCommand, tempDir("endo-cli-ledger-none-"))).toThrow(/no durable ledger/);
		const root = tempDir("endo-cli-ledger-");
		{
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			ledger.append(ARTIFACT);
			ledger.close();
		}
		const out = run(ledgerCommand, root);
		expect(out).toBe(
			canonicalEndoJsonV0({
				replay: {
					layer: "log",
					entryCount: 1,
					fromSnapshot: false,
					verifiedEntries: [
						{
							schemaVersion: "endo.evidence-ledger-entry.v0",
							sequence: 1,
							kind: "artifact",
							recordId: "endo.evidence.art-1",
						},
					],
				},
				recovery: CLEAN_LOG_RECOVERY_V0,
				ledger: {
					schemaVersion: "endo.evidence-ledger.v0",
					id: LEDGER_ID,
					experimentId: EXPERIMENT.id,
					entries: [
						{
							schemaVersion: "endo.evidence-ledger-entry.v0",
							sequence: 1,
							kind: "artifact",
							recordId: "endo.evidence.art-1",
						},
					],
				},
			}),
		);
	});

	it("artifacts lists the stored digests ascending, and an empty root lists nothing", () => {
		expect(run(artifactsCommand, tempDir("endo-cli-artifacts-empty-"))).toBe(canonicalEndoJsonV0([]));
		const root = tempDir("endo-cli-artifacts-");
		const pairs = ["alpha-bytes", "zeta-bytes"].map((text) => ({
			text,
			digest: sha256HexOfBytesV0(Buffer.from(text)),
		}));
		const sorted = [...pairs].sort((a, b) => a.digest.localeCompare(b.digest));
		const store = createEndoArtifactStoreV0(root);
		for (const { text, digest } of sorted) store.put(digest, Buffer.from(text));
		expect(run(artifactsCommand, root)).toBe(canonicalEndoJsonV0(sorted.map((pair) => pair.digest)));
	});

	it("status reports a torn tail without cutting it: the log is byte-identical afterwards", () => {
		const root = tempDir("endo-cli-status-torn-");
		seedEvents(root, 1);
		const logFile = join(root, "events", "events.log");
		rawAppend(logFile, Buffer.from("torn"));
		const before = readFileSync(logFile);
		const out = JSON.parse(run(statusCommand, root)) as { events: { length: number; recovery: unknown } };
		expect(out.events.length).toBe(1);
		expect(out.events.recovery).toEqual({
			...CLEAN_RECOVERY_V0,
			truncated: true,
			tail: { bytes: 4, sha256: sha256HexOfBytesV0(Buffer.from("torn")) },
		});
		expect(readFileSync(logFile)).toEqual(before);
		expect(readdirSync(join(root, "events"))).toEqual(["events.log"]);
		// events reads the same prefix and leaves the tail too; only a writer recovers it.
		expect(JSON.parse(run(eventsCommand, root)).events).toHaveLength(1);
		expect(readFileSync(logFile)).toEqual(before);
	});
});
