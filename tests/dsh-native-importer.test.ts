// The DSH native cold importer (adapters/dsh-native/). Inputs are the committed REAL-runtime fixtures of the PR #70 study
// (research/dsh-native/fixtures/real/, sanitised output of a real DSH 0.2.1-rc.2), plus SYNTHETIC variants built from them by code
// (research/dsh-native/synthetic.ts). Each test says which, and the fixtures are never edited in place.
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
	DSH_NATIVE_KNOWN_EVENT_TYPES_V0,
	DSH_NATIVE_LOSS_ACCOUNTING_V0,
	DSH_NATIVE_MAPPING_VERSION_V0,
	type DshImportReportV0,
	type DshSessionEvent,
	type DshSessionHeader,
	dshEndoSessionIdV0,
	dshFamilyOfEventTypeV0,
	findDshSessionFileV0,
	importDshSessionBytesV0,
	importDshSessionDirectoryV0,
	projectDshTrajectoryV0,
	readDshLog,
} from "../adapters/dsh-native/index.ts";
import { scanZstdFrames } from "../adapters/dsh-native/log.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { validateEndoTrajectoryV0 } from "../protocol/trajectory.ts";
import { encodeFrames, encodeRaw, forkChild, tornFrame } from "../research/dsh-native/synthetic.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoEventStoreV0 } from "../runtime/contracts/event-store.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { compareEndoTrajectoriesV0, endoRecordDigestV0 } from "../runtime/contracts/trajectory.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURES = join(ROOT, "research", "dsh-native", "fixtures", "real");
const CASES = ["tool-read", "no-key-error", "crash-killed", "crash-resumed", "stub-retry"] as const;

const KEY = endoDigestKeyV0(Buffer.alloc(32, 0x41), "importer-test");
const OTHER_KEY = endoDigestKeyV0(Buffer.alloc(32, 0x42), "importer-other");
const PUBLIC_KEY = endoDigestKeyV0(Buffer.alloc(32, 0x43), "fixture-public-test", { public: true });
let tick = 0;
const clock = () => `2026-10-23T00:00:${String(tick++ % 60).padStart(2, "0")}Z`;
const options = { digestKey: KEY, now: () => "2026-10-23T00:00:00Z" };

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs.splice(0)) {
		try {
			chmodSync(dir, 0o755);
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "endo-dsh-import-"));
	dirs.push(dir);
	return dir;
};

const fixture = (name: string): { header: DshSessionHeader; events: DshSessionEvent[] } => {
	const read = readDshLog(readFileSync(join(FIXTURES, `${name}.events.jsonl`)));
	return { header: read.header!, events: read.events };
};
const bytesOf = (name: string): Buffer => readFileSync(join(FIXTURES, `${name}.events.jsonl`));
const allEvents = (store: ReturnType<typeof createEndoEventStoreV0>): EndoEventV0[] =>
	store.page({ limit: 10000 }).events;
const newStore = () => createEndoEventStoreV0();
const importInto = (store: ReturnType<typeof newStore>, bytes: Uint8Array, extra = {}): DshImportReportV0 =>
	importDshSessionBytesV0(bytes, store, { ...options, ...extra });
const trajectory = (store: ReturnType<typeof newStore>, session = "session-1") =>
	projectDshTrajectoryV0(allEvents(store), { session, store: "test-store" });
const kinds = (store: ReturnType<typeof newStore>): string[] => allEvents(store).map((event) => event.kind);

describe("every real-runtime fixture imports into a valid trajectory (REAL fixtures)", () => {
	it.each(CASES)("%s: imports, validates, and compares EXACT with itself on every reported layer", (name) => {
		const store = newStore();
		const report = importInto(store, bytesOf(name));
		expect(report.status).toBe("imported");
		expect(report.refusals).toEqual([]);
		const t = trajectory(store);
		expect(validateEndoTrajectoryV0(JSON.parse(JSON.stringify(t)), endoRecordDigestV0)).not.toBeNull();
		const same = compareEndoTrajectoriesV0(t, t);
		for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const) {
			const entries =
				t.layers[layer].status === "reported" ? (t.layers[layer] as { entries: unknown[] }).entries.length : -1;
			expect(same.layers[layer], layer).toEqual({ status: "EXACT", length: entries });
		}
		expect(same.flags).toEqual([]);
	});

	it("tool-read: a request and its result, a completed run, unavailable usage and timing stay unavailable", () => {
		const store = newStore();
		importInto(store, bytesOf("tool-read"));
		const t = trajectory(store);
		const calls = t.layers.toolCalls;
		const results = t.layers.toolResults;
		if (calls.status !== "reported" || results.status !== "reported") throw new Error("tool layers");
		expect(calls.entries).toHaveLength(1);
		expect(calls.entries[0]).toMatchObject({
			run: 1,
			turn: 1,
			name: { status: "reported", value: "read" },
			argsDigest: { status: "reported" },
		});
		expect(results.entries[0]).toMatchObject({
			run: 1,
			name: { status: "reported", value: "read" },
			status: { status: "reported", value: "ok" },
			resultDigest: { status: "reported" },
		});
		expect(t.layers.outcome).toMatchObject({
			status: "reported",
			entries: [{ run: 1, outcome: "completed", turns: 2 }],
		});
		// DSH never reports cacheWrite: a missing category is not 0, so usage stays unavailable and says why.
		expect(t.layers.usage).toMatchObject({ status: "UNAVAILABLE" });
		expect((t.layers.usage as { reason: string }).reason).toMatch(/not 0/);
		expect(t.layers.timing).toMatchObject({ status: "UNAVAILABLE" });
		expect(t.environment.attachments[0]).toMatchObject({
			version: { status: "UNAVAILABLE" },
			identityDigest: { status: "UNAVAILABLE" },
			mapping: { status: "reported", value: DSH_NATIVE_MAPPING_VERSION_V0 },
			configuredModel: { status: "reported", value: "local/qwen38-local" },
		});
		expect(t.source).toMatchObject({ runtime: "dsh", runtimeSessionId: { status: "reported", value: "session-1" } });
	});

	it("a DSH tool request is never recorded as tool.started or tool.finished", () => {
		const store = newStore();
		importInto(store, bytesOf("tool-read"));
		const all = kinds(store);
		expect(all).toContain("dsh.tool-requested");
		expect(all).toContain("dsh.tool-result-recorded");
		expect(all.filter((kind) => kind.startsWith("tool."))).toEqual([]);
	});

	it("stub-retry: the failed attempt and the retry decision are recorded, with the failure code but not its message", () => {
		const store = newStore();
		importInto(store, bytesOf("stub-retry"));
		const events = allEvents(store);
		expect(events.map((event) => event.kind).filter((kind) => /attempt|retry/.test(kind))).toEqual([
			"dsh.attempt-recorded",
			"dsh.retry-recorded",
			"dsh.retry-started",
		]);
		const retry = events.find((event) => event.kind === "dsh.retry-recorded")!.payload as {
			retry: number;
			failure: { code: string; status: number; messageDigest: unknown; messageBytes: number };
		};
		expect(retry).toMatchObject({ retry: 1, failure: { code: "RATE_LIMIT", status: 429 } });
		expect(retry.failure.messageBytes).toBeGreaterThan(0);
		expect(JSON.stringify(events)).not.toContain("stub transient failure");
	});

	it("no-key-error: a failed run carries the DSH failure code and a keyed message digest", () => {
		const store = newStore();
		importInto(store, bytesOf("no-key-error"));
		const t = trajectory(store);
		const outcome = (
			t.layers.outcome as unknown as {
				entries: { outcome: string; cause: { failure: { code: string; messageDigest: unknown } } }[];
			}
		).entries[0]!;
		expect(outcome.outcome).toBe("failed");
		expect(outcome.cause.failure.code).toBe("PI_AI_ERROR");
		expect(JSON.stringify(allEvents(store))).not.toContain("No API key");
	});
});

describe("lifecycle semantics (REAL crash fixtures)", () => {
	it("crash-killed: the turn and step stay open; nothing is invented", () => {
		const store = newStore();
		importInto(store, bytesOf("crash-killed"));
		const t = trajectory(store);
		expect((t.layers.outcome as { entries: { outcome: string }[] }).entries.map((entry) => entry.outcome)).toEqual([
			"open",
		]);
		const lifecycle = (t.layers.lifecycle as { entries: { kind: string }[] }).entries.map((entry) => entry.kind);
		expect(lifecycle).toEqual(["lifecycle.session-started", "lifecycle.run-started", "lifecycle.turn-started"]);
	});

	it("crash-resumed: DSH's synthetic closers are never lifecycle.interrupted and never a completed step", () => {
		const store = newStore();
		importInto(store, bytesOf("crash-resumed"));
		const lifecycle = allEvents(store).filter((event) => event.kind.startsWith("lifecycle."));
		expect(lifecycle.map((event) => event.kind)).not.toContain("lifecycle.interrupted");
		expect(lifecycle.map((event) => event.kind)).not.toContain("lifecycle.session-resumed");
		const closed = lifecycle.find((event) => event.kind === "lifecycle.run-unclassified")!;
		expect(closed.payload).toMatchObject({
			reportedReason: "interrupted",
			provenance: "dsh-written-closer",
			turns: 1,
		});
		// The orphaned step got no turn-completed: DSH did not say it completed. Turn 2 did complete.
		const completed = lifecycle.filter((event) => event.kind === "lifecycle.turn-completed");
		expect(completed).toHaveLength(1);
		const t = trajectory(store);
		expect(
			(t.layers.outcome as { entries: { outcome: string; cause: unknown }[] }).entries.map((entry) => entry.outcome),
		).toEqual(["unclassified", "completed"]);
		expect((t.layers.outcome as { entries: { cause: unknown }[] }).entries[0]!.cause).toMatchObject({
			reportedReason: "interrupted",
			provenance: "dsh-written-closer",
			finalStep: { turn: 1, output: "none", stepEndWritten: true },
		});
	});

	it("maps the other turn-end reasons faithfully (SYNTHETIC reasons on a real log)", () => {
		const { header, events } = fixture("tool-read");
		const withReason = (reason: unknown): Buffer =>
			encodeRaw(
				header,
				events.map((event) => (event.type === "turn/end" ? { ...event, data: { turn: 1, reason } } : event)),
			);
		const kindOf = (reason: unknown): { kind: string; payload: Record<string, unknown> } => {
			const store = newStore();
			importInto(store, withReason(reason));
			const event = allEvents(store).find((item) =>
				/^lifecycle\.run-(completed|failed|aborted|unclassified)$/.test(item.kind),
			)!;
			return { kind: event.kind, payload: event.payload as Record<string, unknown> };
		};
		expect(kindOf({ kind: "aborted", reason: { kind: "user" } })).toMatchObject({
			kind: "lifecycle.run-aborted",
			payload: { stopRequested: true, abortCause: "user" },
		});
		expect(kindOf({ kind: "aborted", reason: { kind: "parent" } })).toMatchObject({
			kind: "lifecycle.run-aborted",
			payload: { stopRequested: false, abortCause: "parent" },
		});
		expect(kindOf({ kind: "blocked" })).toMatchObject({
			kind: "lifecycle.run-unclassified",
			payload: { reportedReason: "blocked" },
		});
		expect(kindOf({ kind: "max-tokens" })).toMatchObject({
			kind: "lifecycle.run-unclassified",
			payload: { reportedReason: "max-tokens" },
		});
		expect(kindOf({ kind: "forked" })).toMatchObject({
			kind: "lifecycle.run-unclassified",
			payload: { provenance: "dsh-written-closer" },
		});
		expect(
			kindOf({ kind: "error", error: { message: "SECRET failure text", code: "E_X", status: 500 } }),
		).toMatchObject({ kind: "lifecycle.run-failed" });
	});

	it("authority records are runtime-facts about DSH's state, never an Endophasia decision", () => {
		const store = newStore();
		importInto(store, bytesOf("tool-read"));
		const authority = allEvents(store).filter((event) => event.kind === "dsh.authority-recorded");
		expect(authority.map((event) => (event.payload as { record: string }).record)).toEqual([
			"permission/preset",
			"sandbox/mode",
			"approval/policy",
		]);
		for (const event of authority) expect(event.source).toBe("runtime-fact");
		expect(allEvents(store).some((event) => event.source === "authority-decision")).toBe(false);
	});

	it("usage categories are reported only when all five are present; a partial count is never completed with zeros (SYNTHETIC usage)", () => {
		const { header, events } = fixture("tool-read");
		const full = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2, cacheWriteTokens: 1 };
		const withUsage = (usage: (index: number) => Record<string, number> | undefined): Buffer => {
			let index = 0;
			return encodeRaw(
				header,
				events.map((event) => {
					if (event.type !== "assistant/message") return event;
					const next = usage(index++);
					const { usage: _old, ...data } = event.data as Record<string, unknown>;
					return { ...event, data: next === undefined ? data : { ...data, usage: next } };
				}),
			);
		};
		const store = newStore();
		importInto(
			store,
			withUsage(() => full),
		);
		expect((trajectory(store).layers.usage as { entries: { tokens: unknown }[] }).entries[0]!.tokens).toEqual({
			status: "reported",
			value: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2, totalTokens: 30 },
		});
		const partial = newStore();
		importInto(
			partial,
			withUsage((i) => (i === 0 ? full : { inputTokens: 1, outputTokens: 1, totalTokens: 2 })),
		);
		expect(trajectory(partial).layers.usage).toMatchObject({ status: "UNAVAILABLE" });
		const recorded = allEvents(partial)
			.filter((event) => event.kind === "dsh.assistant-recorded")
			.map((event) => (event.payload as { usage: Record<string, number> }).usage);
		expect(recorded[1]).toEqual({ input: 1, output: 1, totalTokens: 2 });
		expect(recorded[1]).not.toHaveProperty("cacheWrite");
	});
});

describe("identity, clocks and idempotence", () => {
	it("importing identical input twice appends nothing the second time", () => {
		const store = newStore();
		const first = importInto(store, bytesOf("tool-read"));
		const length = allEvents(store).length;
		const second = importInto(store, bytesOf("tool-read"), { now: () => "2030-01-01T00:00:00Z" });
		expect(first.status).toBe("imported");
		expect(second).toMatchObject({
			status: "unchanged",
			appended: { header: 0, recorded: 0, lifecycle: 0, checkpoint: 0 },
		});
		expect(allEvents(store)).toHaveLength(length);
		expect(allEvents(store).every((event) => event.at === "2026-10-23T00:00:00Z")).toBe(true);
	});

	it("an extended log appends only the new rows, and the result equals a single full import", () => {
		const { header, events } = fixture("tool-read");
		const full = newStore();
		importInto(full, encodeRaw(header, events));
		for (const upTo of [5, 9, 15, 17, 19]) {
			const store = newStore();
			importInto(store, encodeRaw(header, events.slice(0, upTo)));
			const before = new Set(allEvents(store).map((event) => event.id));
			const report = importInto(store, encodeRaw(header, events));
			expect(report.status, `prefix ${upTo}`).toBe("imported");
			expect(report.appended.recorded).toBe(events.length - upTo);
			const after = allEvents(store);
			// Nothing stored before was replaced, and the final content is the single-import content (producer order aside).
			for (const id of before) expect(after.map((event) => event.id)).toContain(id);
			const byId = (list: EndoEventV0[]) =>
				new Map(
					list
						.filter((e) => !e.kind.startsWith("dsh.import-checkpoint"))
						.map((e) => [e.id, canonicalEndoJsonV0({ ...e, at: "" })] as const),
				);
			expect(byId(after)).toEqual(byId(allEvents(full)));
			expect(trajectory(store).digest).toBe(trajectory(full).digest);
		}
	});

	it("a step's end is decided one row late: a log that stops at step/end has not yet claimed the step completed", () => {
		const { header, events } = fixture("tool-read");
		const stepEnd = events.findIndex((event) => event.type === "step/end");
		const store = newStore();
		importInto(store, encodeRaw(header, events.slice(0, stepEnd + 1)));
		expect(kinds(store).filter((kind) => kind === "lifecycle.turn-completed")).toHaveLength(0);
		importInto(store, encodeRaw(header, events.slice(0, stepEnd + 2)));
		expect(kinds(store).filter((kind) => kind === "lifecycle.turn-completed")).toHaveLength(1);
	});

	it("resumes a partial import: a store that holds some of the events gets exactly the missing ones", () => {
		const full = newStore();
		importInto(full, bytesOf("tool-read"));
		const everything = allEvents(full);
		const partial = newStore();
		// Interleave badly on purpose: ingest only every other event, as an interrupted import might have left it.
		for (const event of everything.filter((_, index) => index % 2 === 0)) partial.ingest(event);
		const report = importInto(partial, bytesOf("tool-read"));
		expect(report.status).toBe("imported");
		expect(new Set(allEvents(partial).map((event) => event.id))).toEqual(
			new Set(everything.map((event) => event.id)),
		);
		expect(trajectory(partial).digest).toBe(trajectory(full).digest);
	});

	it("keeps DSH's seq, DSH's time and the import time apart, and never uses seq as a storage sequence", () => {
		const store = newStore();
		const report = importInto(store, bytesOf("tool-read"), { now: () => "2026-10-23T09:00:00Z" });
		expect(report.session).toBe("endo.session.dsh.session-1");
		const events = store.page({ limit: 10000 }).events;
		const row = fixture("tool-read").events[15]!;
		const stored = events.find(
			(event) =>
				(event.payload as { source?: { dshSeq: number } }).source?.dshSeq === 15 &&
				event.producer === "dsh-native-import.1",
		)!;
		expect(stored.at).toBe("2026-10-23T09:00:00Z");
		expect((stored.payload as { source: { reportedTimeMs: number } }).source.reportedTimeMs).toBe(row.time);
		expect(JSON.stringify(stored.payload)).not.toContain("2026-10-23");
		// Storage order differs from DSH seq (a header event and lifecycle events interleave), and the producer sequence is its own.
		expect(events.indexOf(stored)).not.toBe(15);
		expect(stored.sequence).toBe(16);
	});

	it("deterministic ids: the same session gives the same ids in two separate stores", () => {
		const a = newStore();
		const b = newStore();
		importInto(a, bytesOf("stub-retry"));
		importInto(b, bytesOf("stub-retry"));
		expect(allEvents(a).map((event) => event.id)).toEqual(allEvents(b).map((event) => event.id));
	});

	it("session coordinates: an ordinary id is itself, and a hashed form can never equal a raw id", () => {
		expect(dshEndoSessionIdV0("session-abc")).toBe("endo.session.dsh.session-abc");
		const odd = dshEndoSessionIdV0("a b/c");
		expect(odd).toMatch(/^endo\.session\.dsh\.sha256-[0-9a-f]{48}$/);
		const lookalike = odd.replace("endo.session.dsh.", "");
		expect(dshEndoSessionIdV0(lookalike)).not.toBe(odd);
		expect(dshEndoSessionIdV0(lookalike)).toMatch(/^endo\.session\.dsh\.sha256-/);
	});

	it("refuses a public digest key on a real session unless explicitly allowed", () => {
		expect(() =>
			importDshSessionBytesV0(bytesOf("tool-read"), newStore(), {
				digestKey: PUBLIC_KEY,
				now: () => "2026-10-23T00:00:00Z",
			}),
		).toThrow(/public digest key/);
		expect(
			importDshSessionBytesV0(bytesOf("tool-read"), newStore(), {
				digestKey: PUBLIC_KEY,
				now: () => "2026-10-23T00:00:00Z",
				allowPublicKey: true,
			}).status,
		).toBe("imported");
	});
});

describe("previously imported history is verified, never silently replaced", () => {
	const { header, events } = fixture("tool-read");

	it("detects a changed historical row, reports its DSH seq, and appends nothing", () => {
		const store = newStore();
		importInto(store, encodeRaw(header, events.slice(0, 12)));
		const before = allEvents(store).length;
		const tampered = events.map((event) => (event.seq === 8 ? { ...event, time: event.time + 1 } : event));
		const report = importInto(store, encodeRaw(header, tampered));
		expect(report.status).toBe("refused");
		expect(report.refusals).toEqual([expect.objectContaining({ code: "history-changed", dshSeqs: [8] })]);
		expect(allEvents(store)).toHaveLength(before);
	});

	it("detects a changed header (another session under the same id), a shorter log, another digest key and another mapping", () => {
		const store = newStore();
		importInto(store, encodeRaw(header, events));
		const before = allEvents(store).length;
		expect(
			importInto(store, encodeRaw({ ...header, createdAt: header.createdAt + 5 }, events)).refusals[0],
		).toMatchObject({ code: "history-changed" });
		expect(importInto(store, encodeRaw(header, events.slice(0, 10))).refusals.map((r) => r.code)).toContain(
			"source-shorter",
		);
		expect(
			importDshSessionBytesV0(encodeRaw(header, events), store, {
				digestKey: OTHER_KEY,
				now: () => "x",
			}).refusals.map((r) => r.code),
		).toContain("digest-domain-differs");
		// Another mapping version: a store whose header event was written by a different mapping.
		const foreign = newStore();
		for (const event of allEvents(store)) {
			foreign.ingest(
				event.kind === "dsh.session-imported"
					? { ...event, payload: { ...(event.payload as object), mapping: "dsh-native-mapping.0" } }
					: event,
			);
		}
		expect(importInto(foreign, encodeRaw(header, events)).refusals.map((r) => r.code)).toContain("mapping-changed");
		expect(allEvents(store)).toHaveLength(before);
	});

	it("two different sessions that happen to share an id are not merged", () => {
		const store = newStore();
		importInto(store, bytesOf("tool-read"));
		const other = importInto(store, bytesOf("crash-killed"));
		expect(other.status).toBe("refused");
		expect(other.refusals.map((refusal) => refusal.code)).toContain("history-changed");
	});
});

describe("damaged, hostile and unsupported input", () => {
	const { header, events } = fixture("tool-read");
	const framed = encodeFrames(header, events, 4);
	const frames = scanZstdFrames(framed).frames;

	it("imports the complete prefix of a torn frame, reports the tail, and leaves the digest of that prefix unchanged", () => {
		const clean = newStore();
		importInto(clean, encodeFrames(header, events.slice(0, (frames.length - 1) * 4), 4));
		for (const keep of [1, 7, frames.at(-1)!.end - frames.at(-1)!.start - 1]) {
			const store = newStore();
			const report = importInto(store, tornFrame(framed, keep, frames));
			expect(report.status).toBe("imported");
			expect(report.tail.kind).toBe("torn-frame");
			expect(report.sourceRows).toBe((frames.length - 1) * 4);
			expect(trajectory(store).digest, `keep ${keep}`).toBe(trajectory(clean).digest);
		}
	});

	it("reports a torn raw row and an unterminated final row, and imports the complete rows", () => {
		const raw = encodeRaw(header, events);
		const store = newStore();
		const report = importInto(store, raw.subarray(0, raw.length - 30));
		expect(report.tail.kind).toBe("torn-row");
		expect(report.sourceRows).toBe(events.length - 1);
		const unterminated = Buffer.from(raw.toString("utf8").replace(/\n$/, ""));
		expect(importInto(newStore(), unterminated).tail.kind).toBe("torn-row");
	});

	it("rejects other format generations, unknown required types, non-ignorable plugin records and sequence gaps", () => {
		const reasons = (bytes: Uint8Array) => [...new Set(importInto(newStore(), bytes).refusals.map((r) => r.code))];
		expect(reasons(encodeRaw({ ...header, version: 3 }, events))).toEqual(["unsupported-format"]);
		expect(reasons(encodeRaw({ ...header, version: 5 }, events))).toEqual(["unsupported-format"]);
		const insert = (extra: Partial<DshSessionEvent>) =>
			[
				...events.slice(0, 6),
				{ type: "x", seq: 0, time: events[6]!.time, data: {}, ...extra } as DshSessionEvent,
				...events.slice(6),
			].map((e, seq) => ({ ...e, seq }));
		expect(reasons(encodeRaw(header, insert({ type: "future/record" })))).toEqual(["invalid-log"]);
		expect(reasons(encodeRaw(header, insert({ type: "plugin:acme/state" })))).toEqual(["invalid-log"]);
		expect(
			importInto(newStore(), encodeRaw(header, insert({ type: "plugin:acme/state", ignorable: true }))).status,
		).toBe("imported");
		expect(
			reasons(
				encodeRaw(
					header,
					events.map((e, i) => (i > 5 ? { ...e, seq: e.seq + 1 } : e)),
				),
			),
		).toEqual(["invalid-log"]);
		expect(reasons(Buffer.alloc(0))).toEqual(["no-header"]);
	});

	it("fails safely on a decompression bomb and on garbage", () => {
		const bomb = Buffer.concat([
			framed,
			zstdCompressSync(Buffer.alloc(80 * 1024 * 1024), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
		]);
		expect(bomb.length).toBeLessThan(10_000_000);
		const report = importInto(newStore(), bomb);
		expect(report.status).toBe("refused");
		expect(report.refusals[0]!.code).toBe("unreadable");
		expect(report.refusals[0]!.detail).toMatch(/exceed/);
		expect(importInto(newStore(), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff])).status).toBe("refused");
		expect(importInto(newStore(), Buffer.from("not a session log")).status).toBe("refused");
	});

	it("a fork child is imported from its validated cut, without the inherited prefix, with the parent as a reference (SYNTHETIC)", () => {
		const child = forkChild(header, events, 9, events.slice(9, 14));
		const store = newStore();
		const report = importInto(store, encodeRaw(child.header, child.events));
		expect(report.status).toBe("imported");
		const header$ = allEvents(store).find((event) => event.kind === "dsh.session-imported")!.payload as Record<
			string,
			unknown
		>;
		expect(header$).toMatchObject({ isSeeded: true, inheritedCut: 9, parentSession: "endo.session.dsh.session-1" });
		const seqs = allEvents(store)
			.filter((e) => e.producer === "dsh-native-import.1" && e.kind !== "dsh.session-imported")
			.map((e) => (e.payload as { source: { dshSeq: number } }).source.dshSeq);
		expect(Math.min(...seqs)).toBe(9);
		expect(seqs).toHaveLength(child.events.length - 9);
		// Header and marker disagree: the cut is unestablished, so nothing is imported.
		const broken = forkChild(header, events, 9, events.slice(9, 14), false);
		const refused = importInto(newStore(), encodeRaw(broken.header, broken.events));
		expect(refused.status).toBe("refused");
		expect(refused.refusals[0]!.detail).toMatch(/fork-cut-unestablished/);
	});
});

describe("read-only toward DSH (no lock, no write, no repair)", () => {
	it("imports from a read-only session directory without creating, changing or touching any file there", () => {
		const root = scratch();
		const dir = join(root, "--ws--", "session-1");
		mkdirSync(dir, { recursive: true });
		const { header, events } = fixture("tool-read");
		writeFileSync(join(dir, "session.v4.jsonl.zstd"), encodeFrames(header, events, 4));
		writeFileSync(join(dir, "session.lock"), "");
		const snapshot = () =>
			readdirSync(dir).map(
				(name) => [name, statSync(join(dir, name)).mtimeMs, statSync(join(dir, name)).size] as const,
			);
		for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o444);
		chmodSync(dir, 0o555);
		const before = snapshot();
		const store = newStore();
		const report = importDshSessionDirectoryV0(dir, store, options);
		expect(report.status).toBe("imported");
		expect(snapshot()).toEqual(before);
		expect(readdirSync(dir).sort()).toEqual(["session.lock", "session.v4.jsonl.zstd"]);
		// A torn tail on disk is reported and left exactly as found.
		chmodSync(dir, 0o755);
		const file = join(dir, "session.v4.jsonl.zstd");
		chmodSync(file, 0o644);
		const bytes = readFileSync(file);
		const cut = bytes.subarray(0, bytes.length - 3);
		writeFileSync(file, cut);
		const torn = importDshSessionDirectoryV0(dir, newStore(), options);
		expect(torn.tail.kind).toBe("torn-frame");
		expect(readFileSync(file).equals(cut)).toBe(true);
	});

	it("refuses another format generation by file name and an ambiguous directory", () => {
		const dir = scratch();
		const { header, events } = fixture("tool-read");
		writeFileSync(join(dir, "session.v4.jsonl"), encodeRaw(header, events));
		writeFileSync(join(dir, "session.v5.jsonl"), "{}\n");
		expect(importDshSessionDirectoryV0(dir, newStore(), options).refusals[0]).toMatchObject({
			code: "unsupported-format",
		});
		const both = scratch();
		writeFileSync(join(both, "session.v4.jsonl"), "x");
		writeFileSync(join(both, "session.v4.jsonl.zstd"), "x");
		expect(() => findDshSessionFileV0(both)).toThrow(/highest generation/);
		expect(() => findDshSessionFileV0(scratch())).toThrow(/no DSH session log/);
	});

	it("the adapter's source opens nothing for writing, takes no lock, and spawns nothing", () => {
		const dir = join(ROOT, "adapters", "dsh-native");
		for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
			const code = readFileSync(join(dir, name), "utf8")
				.replace(/^\s*\/\/.*$/gm, "")
				.replace(/\/\*[\s\S]*?\*\//g, "");
			expect(code, name).not.toMatch(
				/\b(writeFile|writeFileSync|appendFile|appendFileSync|openSync|createWriteStream|truncate|unlink|rmSync|renameSync|mkdirSync|flock|child_process|spawnSync|execSync|execFile|execFileSync)\b/,
			);
			for (const match of code.matchAll(/^import [^;]*? from "([^"]+)";/gm)) {
				const target = match[1]!;
				if (target.startsWith("node:"))
					expect(["node:fs", "node:path", "node:zlib", "node:crypto"], `${name} imports ${target}`).toContain(
						target,
					);
				else expect(target, name).toMatch(/^\.\.?\//);
				expect(target, name).not.toMatch(/storage\/|adapters\/(pi|acp|codex)|cockpit|cli\//);
			}
		}
		const importCode = readFileSync(join(dir, "import.ts"), "utf8");
		expect(importCode).toMatch(/import \{ readdirSync, readFileSync \} from "node:fs"/);
	});
});

describe("no private content survives the whole path (SYNTHETIC canaries on a real log)", () => {
	it("keeps every canary out of the stored events, the on-disk store and the trajectory", () => {
		const canaries = [
			"CANARY-SYSTEM",
			"CANARY-PROMPT",
			"CANARY-INJECTED",
			"CANARY-REASONING",
			"CANARY-ARGS",
			"CANARY-RESULT",
			"CANARY-FAILURE",
			"CANARY-TITLE",
			"CANARY-APPROVAL",
			"CANARY-CWD",
			"CANARY-PRESET",
			"CANARY-META",
			"CANARY-ERRORREASON",
			"CANARY-SUMMARY",
			"CANARY-SESSION-ID",
			"CANARY-CALL-ID/with-path",
		];
		const { header, events } = fixture("tool-read");
		const text = (value: string) => [{ type: "text", text: value }];
		const dirty = events.map((event): DshSessionEvent => {
			const data = JSON.parse(JSON.stringify(event.data)) as Record<string, any>;
			switch (event.type) {
				case "system/message":
					data.message.content = text("CANARY-SYSTEM");
					break;
				case "user/message":
					if (data.source?.kind === "user") data.content = text("CANARY-PROMPT");
					else {
						data.content = text("CANARY-INJECTED");
						data.source.sections = [{ name: "x", text: "CANARY-INJECTED" }];
					}
					break;
				case "assistant/message":
					for (const part of data.message.content) {
						if (part.type === "reasoning") part.text = "CANARY-REASONING";
						if (part.type === "tool-call") {
							part.arguments = '{"path":"CANARY-ARGS"}';
							part.id = "CANARY-CALL-ID/with-path";
						}
					}
					break;
				case "tool/call":
					data.callId = "CANARY-CALL-ID/with-path";
					data.arguments = '{"file_path":"CANARY-ARGS"}';
					break;
				case "tool/result":
					data.message.toolCallId = "CANARY-CALL-ID/with-path";
					data.message.content = text("CANARY-RESULT");
					data.meta = { diff: "CANARY-META" };
					data.error = { name: "E", code: "E_CODE", reason: "CANARY-ERRORREASON" };
					break;
				case "session/title":
					data.title = "CANARY-TITLE";
					break;
				case "turn/end":
					data.reason = { kind: "error", error: { message: "CANARY-FAILURE", code: "E_X", status: 500 } };
					break;
				default:
			}
			return { ...event, data };
		});
		dirty.push({
			type: "approval/asked",
			seq: dirty.length,
			time: dirty.at(-1)!.time,
			data: { id: "ap-1", toolName: "read", callId: "CANARY-CALL-ID/with-path", reason: "CANARY-APPROVAL" },
		});
		dirty.push({
			type: "compaction/summary",
			seq: dirty.length,
			time: dirty.at(-1)!.time,
			data: { summary: text("CANARY-SUMMARY") },
		});
		const dirtyHeader = { ...header, id: "/CANARY-SESSION-ID", cwd: "/CANARY-CWD/ws", agentPreset: "CANARY-PRESET" };
		// Through the durable store, to disk, and out again as a trajectory.
		const root = scratch();
		const store = createEndoDurableEventStoreV0(root);
		const report = importDshSessionBytesV0(encodeFrames(dirtyHeader, dirty, 4), store, options);
		expect(report.status, JSON.stringify(report.refusals)).toBe("imported");
		const stored = store.page({ limit: 10000 }).events;
		const t = projectDshTrajectoryV0(stored, { session: dirtyHeader.id, store: root });
		const outputs = [
			canonicalEndoJsonV0(stored),
			canonicalEndoJsonV0(t),
			readFileSync(join(root, "events", "events.log")).toString("latin1"),
		];
		for (const canary of canaries) for (const output of outputs) expect(output, canary).not.toContain(canary);
		store.close();
	});
});

describe("loss accounting is tied to the pinned study (vocabulary and matrix)", () => {
	const vocabulary = JSON.parse(readFileSync(join(ROOT, "research", "dsh-native", "vocabulary.json"), "utf8")) as {
		knownEventTypes: string[];
		sessionFormatVersion: number;
	};
	const matrix = JSON.parse(readFileSync(join(ROOT, "research", "dsh-native", "matrix.json"), "utf8")) as {
		rows: { id: string; eventTypes: string[] }[];
		vocabulary: { verdicts: string[] };
	};

	it("pins the same 62 event types as the study, and accounts for every one exactly once", () => {
		expect([...DSH_NATIVE_KNOWN_EVENT_TYPES_V0].sort()).toEqual([...vocabulary.knownEventTypes].sort());
		const accounted = DSH_NATIVE_LOSS_ACCOUNTING_V0.entries.flatMap((entry) => entry.dshEventTypes);
		expect(new Set(accounted).size).toBe(accounted.length);
		expect([...accounted].sort()).toEqual([...vocabulary.knownEventTypes].sort());
		for (const type of vocabulary.knownEventTypes) expect(dshFamilyOfEventTypeV0(type), type).toBeDefined();
		expect(dshFamilyOfEventTypeV0("future/record")).toBeUndefined();
	});

	it("has one entry per matrix row with the same event types, a valid verdict and an honest status", () => {
		expect(DSH_NATIVE_LOSS_ACCOUNTING_V0.entries.map((entry) => entry.id)).toEqual(matrix.rows.map((row) => row.id));
		for (const [index, entry] of DSH_NATIVE_LOSS_ACCOUNTING_V0.entries.entries()) {
			expect([...entry.dshEventTypes]).toEqual(matrix.rows[index]!.eventTypes);
			expect(matrix.vocabulary.verdicts).toContain(entry.verdict);
			expect(["implemented", "recorded-only", "not-importable"]).toContain(entry.status);
			expect(entry.unprojected.length).toBeGreaterThan(10);
		}
		expect(DSH_NATIVE_LOSS_ACCOUNTING_V0).toMatchObject({
			version: "endo.dsh-native-loss-accounting.v0",
			mapping: DSH_NATIVE_MAPPING_VERSION_V0,
		});
		expect(vocabulary.sessionFormatVersion).toBe(4);
	});

	it("every recorded kind the real fixtures produce belongs to an accounted family", () => {
		const produced = new Set<string>();
		for (const name of CASES) {
			const store = newStore();
			importInto(store, bytesOf(name));
			for (const event of allEvents(store))
				if (event.kind.startsWith("dsh.") && event.kind !== "dsh.record") produced.add(event.kind);
		}
		expect([...produced].sort()).toEqual([
			"dsh.assistant-recorded",
			"dsh.attempt-recorded",
			"dsh.authority-recorded",
			"dsh.import-checkpoint",
			"dsh.message-recorded",
			"dsh.request-config-recorded",
			"dsh.request-route-recorded",
			"dsh.retry-recorded",
			"dsh.retry-started",
			"dsh.seed-boundary",
			"dsh.session-imported",
			"dsh.step-ended",
			"dsh.step-started",
			"dsh.tool-requested",
			"dsh.tool-result-recorded",
			"dsh.turn-ended",
			"dsh.turn-started",
		]);
	});
});

describe("DSH stays inside its adapter and explicit CLI leaf", () => {
	it("no neutral module or other adapter imports DSH; only the CLI leaf and read-only HTTP comparison opt in", () => {
		const walk = (path: string): string[] =>
			readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
				entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
			);
		for (const dir of [
			"protocol",
			"runtime",
			"storage",
			"cockpit",
			"cockpit-http",
			"studio-ui/src",
			"adapters/pi",
			"adapters/acp",
			"adapters/rpc-jsonl",
			"cli",
		]) {
			for (const file of walk(join(ROOT, dir)).filter((name) => /\.(ts|tsx)$/.test(name))) {
				let source = readFileSync(file, "utf8");
				if (file === join(ROOT, "cockpit-http", "comparison.ts")) {
					expect(source).toContain('from "../adapters/dsh-native/trajectory.ts"');
					expect(source).not.toMatch(
						/from "[^"]*(?:dsh-native\/(?:index|import|lifecycle)|pi\/(?:index|attachment|rpc))\.ts"/,
					);
					expect(source).not.toMatch(
						/importDshSessionBytesV0|readDshLog|foldDshLifecycleV0|node:fs|node:child_process|process\.|setInterval/,
					);
					continue;
				}
				if (file === join(ROOT, "cli", "dsh.ts")) {
					expect(source).toContain('from "../adapters/dsh-native/import.ts"');
					expect(source).not.toMatch(
						/importDshSessionBytesV0|readDshLog|foldDshLifecycleV0|projectDshTrajectoryV0/,
					);
					continue;
				}
				if (file === join(ROOT, "cli", "index.ts")) source = source.replace('"./dsh.ts"', '"./chosen-harness.ts"');
				expect(source, file).not.toMatch(/dsh-native|DeepSeek Harness|@deepseek-ai\/dsh|\bdsh\./i);
			}
		}
	});

	it("uses the existing CLI closure build rather than a DSH-specific build path", () => {
		const build = readFileSync(join(ROOT, "scripts", "build-cli.mjs"), "utf8");
		expect(build).not.toMatch(/dsh-native/);
		void [cpSync, clock];
	});
});
