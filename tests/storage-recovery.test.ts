// Store recovery hardening (docs/audits/pr14-post-merge.md T1, T6, L5, L6). Every store built on the frame log — the
// event store, the harness registry, the evidence ledger — is attacked the same way, byte by byte, under a fresh temp
// root:
// - a torn tail is cut only by a writable open, only after every remaining frame validated, and the cut is reported
//   (length, sha256, where the bytes were preserved);
// - a corrupt middle frame seals the store in either mode and changes nothing on disk;
// - a store that cannot be opened is left byte-for-byte as found, even with a torn tail;
// - a read-only open of a damaged or absent store creates and changes nothing, and refuses every write.
// Short writes are covered separately in storage-short-write.test.ts, which has to mock node:fs.
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { artifactsCommand, eventsCommand, ledgerCommand, statusCommand } from "../cli/commands.ts";
import { harnessStatusCommand } from "../cli/harness.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoArtifactV0, EndoCandidateV0, EndoExperimentRecordV0, EndoMutationV0 } from "../protocol/evolution.ts";
import type { EndoHarnessNotificationV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoArtifactStoreV0, sha256HexOfBytesV0 } from "../storage/artifacts.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { createEndoDurableEvidenceLedgerV0 } from "../storage/ledger.ts";
import { createEndoFrameLogV0, type EndoFrameLogRecoveryV0 } from "../storage/log.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
	vi.restoreAllMocks();
});

function rawAppend(file: string, bytes: Uint8Array): void {
	const fd = openSync(file, "a");
	try {
		writeSync(fd, Buffer.from(bytes));
	} finally {
		closeSync(fd);
	}
}

/** Increment one byte of frame `index` (0-based), inside its payload. */
function corruptFrame(file: string, index: number): void {
	const buffer = readFileSync(file);
	let offset = 0;
	for (let n = 0; n < index; n += 1) offset += 4 + buffer.readUInt32BE(offset) + 32;
	buffer[offset + 5] = (buffer[offset + 5]! + 1) % 256;
	writeFileSync(file, buffer);
}

/** Every file and directory under `root`, each file with the sha256 of its bytes: the whole on-disk state. */
function tree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(root)) return out;
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				out[`${relative(root, path)}/`] = "dir";
				walk(path);
			} else {
				out[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
			}
		}
	};
	walk(root);
	return out;
}

const TORN = Buffer.from([0, 0, 0, 40, 1, 2, 3, 4, 5]);

// ---------------------------------------------------------------------------
// The three frame-log stores, behind one shape
// ---------------------------------------------------------------------------

function event(n: number): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id: `endo.event.r${n}`,
		kind: "session.started",
		source: "runtime-fact",
		sequence: n,
		at: "2026-10-03T11:00:00Z",
		coordinates: { sessionId: "endo.session.s1" },
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: {},
	};
}

function notification(n: number): EndoHarnessNotificationV0 {
	return {
		schemaVersion: "endo.harness-notification.v0",
		id: `endo.evidence.note-${n}`,
		attachment: "pi.default",
		at: "2026-10-03T11:00:00Z",
		kind: "runtime-changed",
		changeId: `endo.evidence.change-${n}`,
		title: "Pi runtime changed",
		lines: [`notice ${n}`],
	};
}

const EXPERIMENT: EndoExperimentRecordV0 = { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-r" };
const LEDGER_ID = "endo.evidence.ledger-r";
const LEDGER_RECORDS: [EndoArtifactV0, EndoMutationV0, EndoCandidateV0, EndoCandidateV0] = [
	(() => {
		const content = { text: "prompt" };
		return {
			schemaVersion: "endo.artifact.v0",
			id: "endo.evidence.art-r",
			kind: "policy.prompt",
			digest: sha256HexV0(canonicalEndoJsonV0(content)),
			content,
		} satisfies EndoArtifactV0;
	})(),
	{
		schemaVersion: "endo.mutation.v0",
		id: "endo.evidence.mut-r",
		component: "policy.prompt",
		operation: "replace",
		artifactId: "endo.evidence.art-r",
	},
	{ schemaVersion: "endo.candidate.v0", id: "endo.candidate.r1", mutations: ["endo.evidence.mut-r"] },
	{ schemaVersion: "endo.candidate.v0", id: "endo.candidate.r2", mutations: ["endo.evidence.mut-r"] },
];

interface OpenedStoreV0 {
	count(): number;
	/** Write one more (valid, new) record. */
	write(): void;
	recovery(): EndoFrameLogRecoveryV0;
}

interface StoreCaseV0 {
	name: string;
	logFile(root: string): string;
	/** Write three valid records through a writable open. */
	seed(root: string): void;
	open(root: string, readOnly: boolean): OpenedStoreV0;
	/** A frame payload that verifies but that the store's rules reject. */
	invalidPayload: Buffer;
}

const STORES: StoreCaseV0[] = [
	{
		name: "event store",
		logFile: (root) => join(root, "events", "events.log"),
		seed(root) {
			const store = createEndoDurableEventStoreV0(root);
			for (const n of [1, 2, 3]) store.ingest(event(n));
			store.close();
		},
		open(root, readOnly) {
			const store = createEndoDurableEventStoreV0(root, { readOnly });
			return { count: () => store.length, write: () => store.ingest(event(4)), recovery: () => store.recovery() };
		},
		invalidPayload: Buffer.from(canonicalEndoJsonV0(event(1))), // a duplicate id
	},
	{
		name: "harness registry",
		logFile: (root) => join(root, "harness", "pi.default", "records.log"),
		seed(root) {
			const registry = openEndoHarnessRegistryV0(root, "pi.default");
			for (const n of [1, 2, 3]) registry.append("notification", notification(n));
		},
		open(root, readOnly) {
			const registry = openEndoHarnessRegistryV0(root, "pi.default", { readOnly });
			return {
				count: () => registry.list("notification").length,
				write: () => registry.append("notification", notification(4)),
				recovery: () => registry.recovery(),
			};
		},
		invalidPayload: Buffer.from(canonicalEndoJsonV0({ kind: "not-a-kind", record: {} })),
	},
	{
		name: "evidence ledger",
		logFile: (root) => join(root, "ledger", "ledger.log"),
		seed(root) {
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT);
			for (const record of LEDGER_RECORDS.slice(0, 3)) ledger.append(record);
			ledger.close();
		},
		open(root, readOnly) {
			const ledger = createEndoDurableEvidenceLedgerV0(root, LEDGER_ID, EXPERIMENT, { readOnly });
			return {
				count: () => ledger.length,
				write: () => ledger.append(LEDGER_RECORDS[3]),
				recovery: () => ledger.recovery(),
			};
		},
		// A candidate whose mutation was never recorded: a broken reference.
		invalidPayload: Buffer.from(
			canonicalEndoJsonV0({
				schemaVersion: "endo.candidate.v0",
				id: "endo.candidate.rx",
				mutations: ["endo.evidence.nope"],
			}),
		),
	},
];

describe.each(STORES)("$name recovery", (store) => {
	it("a writable open cuts a torn tail only after validating, preserves it, and reports length and sha256", () => {
		const root = tempDir("endo-recovery-torn-");
		store.seed(root);
		const log = store.logFile(root);
		const prefix = readFileSync(log);
		rawAppend(log, TORN);
		const sha256 = sha256HexOfBytesV0(TORN);
		const opened = store.open(root, false);
		const preservedAt = `${log}.discarded-${sha256.slice(0, 16)}`;
		expect(opened.recovery()).toEqual({
			readOnly: false,
			truncated: true,
			tail: { bytes: TORN.length, sha256 },
			recovered: true,
			discarded: { bytes: TORN.length, sha256, preservedAt },
			sealed: false,
			corruptAt: null,
			...(store.name === "event store" ? { discardedPartial: true } : {}),
		});
		expect(readFileSync(log)).toEqual(prefix);
		expect(readFileSync(preservedAt)).toEqual(TORN);
		expect(opened.count()).toBe(3);
		opened.write();
		const reopened = store.open(root, false);
		expect(reopened.count()).toBe(4);
		expect(reopened.recovery()).toMatchObject({ truncated: false, recovered: false, discarded: null });
	});

	it("a corrupt middle frame seals the store in both modes and changes nothing on disk", () => {
		const root = tempDir("endo-recovery-corrupt-");
		store.seed(root);
		corruptFrame(store.logFile(root), 1);
		const before = tree(root);
		for (const readOnly of [true, false]) {
			const opened = store.open(root, readOnly);
			expect(opened.recovery()).toMatchObject({
				readOnly,
				truncated: false,
				recovered: false,
				discarded: null,
				sealed: true,
				corruptAt: 2,
			});
			expect(opened.count()).toBe(1);
			expect(() => opened.write()).toThrow(TypeError);
			expect(tree(root)).toEqual(before);
		}
	});

	it("a store that cannot be opened is left byte-identical, even with a torn tail to cut", () => {
		const root = tempDir("endo-recovery-unopenable-");
		store.seed(root);
		const log = store.logFile(root);
		createEndoFrameLogV0(log).append(store.invalidPayload);
		rawAppend(log, TORN);
		const before = tree(root);
		expect(() => store.open(root, false)).toThrow(TypeError);
		expect(() => store.open(root, true)).toThrow(TypeError);
		expect(tree(root)).toEqual(before);
	});

	it("a read-only open of a torn store reports the tail, cuts nothing, and refuses writes", () => {
		const root = tempDir("endo-recovery-readonly-");
		store.seed(root);
		rawAppend(store.logFile(root), TORN);
		const before = tree(root);
		const opened = store.open(root, true);
		expect(opened.recovery()).toMatchObject({
			readOnly: true,
			truncated: true,
			tail: { bytes: TORN.length, sha256: sha256HexOfBytesV0(TORN) },
			recovered: false,
			discarded: null,
			sealed: false,
			corruptAt: null,
		});
		expect(opened.count()).toBe(3);
		expect(() => opened.write()).toThrow(/read-only/);
		expect(tree(root)).toEqual(before);
	});

	it("a read-only open of an absent root creates nothing", () => {
		const root = join(tempDir("endo-recovery-absent-"), "absent");
		const opened = store.open(root, true);
		expect(opened.count()).toBe(0);
		expect(opened.recovery()).toMatchObject({ readOnly: true, truncated: false, sealed: false });
		expect(() => opened.write()).toThrow(/read-only/);
		expect(existsSync(root)).toBe(false);
	});
});

describe("artifact store, read-only", () => {
	it("creates no directory and refuses put", () => {
		const root = tempDir("endo-recovery-artifacts-");
		const store = createEndoArtifactStoreV0(root, { readOnly: true });
		const bytes = Buffer.from("content");
		expect(() => store.put(sha256HexOfBytesV0(bytes), bytes)).toThrow(/read-only/);
		expect(store.list()).toEqual([]);
		expect(readdirSync(root)).toEqual([]);
	});
});

describe("the reporting commands leave a damaged root byte-identical", () => {
	const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

	it("status, events, ledger and artifacts over torn event and ledger logs", () => {
		const root = tempDir("endo-recovery-cli-");
		STORES[0]!.seed(root);
		STORES[2]!.seed(root);
		rawAppend(STORES[0]!.logFile(root), TORN);
		rawAppend(STORES[2]!.logFile(root), TORN);
		const before = tree(root);
		quiet();
		statusCommand([root]);
		eventsCommand([root]);
		ledgerCommand([root]);
		artifactsCommand([root]);
		expect(tree(root)).toEqual(before);
	});

	it("harness status over a torn registry, and with an attachment that does not exist (L5)", async () => {
		const root = tempDir("endo-recovery-harness-");
		STORES[1]!.seed(root);
		rawAppend(STORES[1]!.logFile(root), TORN);
		const before = tree(root);
		const log = quiet();
		await harnessStatusCommand([root]);
		const printed = JSON.parse(String(log.mock.calls[0]![0])) as { recovery: EndoFrameLogRecoveryV0 };
		expect(printed.recovery).toMatchObject({ readOnly: true, truncated: true, recovered: false });
		await harnessStatusCommand([root, "--attachment", "pi.typo"]);
		expect(tree(root)).toEqual(before);
		expect(existsSync(join(root, "harness", "pi.typo"))).toBe(false);
	});
});
