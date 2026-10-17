// The store-to-projection path: real durable stores on disk (the committed fake-Pi lifecycle recordings and the committed
// Pi 1.0.0 specimen), opened read-only by the cockpit reader and projected. The fixtures are FAKE-Pi recordings and a
// real-Pi specimen replayed into a store; they establish that the bridge reads and projects what the substrate recorded,
// not anything about a live runtime.
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	checkEndoCockpitSourceFreshnessV0,
	ENDO_COCKPIT_PAGE_MAX_LIMIT_V0,
	listEndoCockpitAttachmentsV0,
	projectEndoCockpitSessionTimelineV0,
	readEndoCockpitEventLogV0,
	readEndoCockpitRegistryV0,
	readEndoCockpitSnapshotV0,
	readEndoCockpitTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../cockpit/index.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { createEndoFrameLogV0, endoFrameBytesV0 } from "../storage/log.ts";
import {
	ATTACHMENT,
	CANARY,
	changeRecord,
	event,
	ingestAll,
	lifecycleEvents,
	notificationRecord,
	removeTempRoots,
	seedRegistry,
	specimen,
	tempRoot,
	treeHash,
} from "./cockpit-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const FIXTURE = "killed-and-resumed";

/**
 * What the watermark's prefix digest is, restated independently of the reader: the sha256 over one line per event in
 * storage order, each line the hex sha256 of the event's canonical JSON and a newline.
 */
const idsDigest = (events: readonly unknown[]) =>
	sha256HexV0(events.map((e) => `${sha256HexV0(canonicalEndoJsonV0(e))}\n`).join(""));
const eventsLog = (root: string) => join(root, "events", "events.log");
const registryLog = (root: string) => join(root, "harness", ATTACHMENT, "records.log");

function seeded(): { root: string; events: ReturnType<typeof lifecycleEvents> } {
	const root = tempRoot();
	const events = lifecycleEvents(FIXTURE);
	ingestAll(root, events);
	seedRegistry(root);
	return { root, events };
}

function appendFrame(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const log = createEndoFrameLogV0(path);
	log.append(new TextEncoder().encode(JSON.stringify(value)));
}

function flipByte(path: string, offset: number): void {
	const bytes = readFileSync(path);
	bytes[offset] = bytes[offset]! ^ 0xff;
	writeFileSync(path, bytes);
}

/** The byte offset where frame `index` (0-based) starts. */
function frameStart(path: string, index: number): number {
	const bytes = readFileSync(path);
	let offset = 0;
	for (let i = 0; i < index; i += 1) offset += 4 + bytes.readUInt32BE(offset) + 32;
	return offset;
}

describe("store to projection", () => {
	it("projects a recorded store to exactly what the records say", () => {
		const { root, events } = seeded();
		const snapshot = readEndoCockpitSnapshotV0(root, { limit: events.length });
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();

		// The timeline is the JSONL in storage order, with nothing added.
		expect(snapshot.timeline.entries.map((entry) => entry.eventId)).toEqual(events.map((e) => e.id));
		expect(snapshot.timeline.entries.map((entry) => entry.storageSequence)).toEqual(events.map((_, i) => i + 1));
		expect(snapshot.timeline.source).toEqual({
			domain: "event-log",
			condition: { state: "readable", tornTail: null, sealedAt: null, error: null },
			watermark: { length: events.length, lastEventId: events.at(-1)!.id, prefixDigest: idsDigest(events) },
		});
		expect(snapshot.timeline.window.hasMore).toBe(false);

		// The same projection, computed directly from the parsed records, is byte-identical.
		const direct = projectEndoCockpitSessionTimelineV0({
			source: snapshot.timeline.source,
			afterSequence: 0,
			events: events.map((e, i) => ({ storageSequence: i + 1, event: e })),
		});
		expect(canonicalEndoJsonV0(snapshot.timeline)).toBe(canonicalEndoJsonV0(direct));

		// The lifecycle events keep the recorded interruption and resume, in the recorded order.
		const lifecycle = snapshot.timeline.entries.filter((e) => e.category === "lifecycle").map((e) => e.kind);
		expect(lifecycle).toEqual(events.filter((e) => e.kind.startsWith("lifecycle.")).map((e) => e.kind));
		expect(lifecycle).toContain("lifecycle.interrupted");
		expect(snapshot.timeline.entries.find((e) => e.kind === "lifecycle.session-resumed")!.flags).toEqual([
			"discontinuity",
		]);
		expect(snapshot.timeline.entries.every((e) => e.runId === null)).toBe(true);
		expect(
			snapshot.timeline.entries.find((e) => e.kind === "lifecycle.session-started")!.fields["unavailable.run.id"],
		).toMatchObject({
			basis: "unavailable",
		});

		// The registry side is the specimen, read through the registry.
		const [runtime] = snapshot.runtimes;
		const { fingerprint, state } = specimen();
		expect(runtime!.identity.current!.id).toBe(fingerprint.id);
		expect(runtime!.capabilities.state).toMatchObject({ currency: "current", fingerprintId: state.fingerprintId });
		expect(
			runtime!.capabilities.capabilities.map((c) => [c.capability, c.status, c.classification, c.reason]),
		).toEqual(state.capabilities.map((c) => [c.capability, c.status, c.classification, c.reason]));
	});

	it("is repeatable: two reads of unchanged stores give byte-identical output", () => {
		const { root } = seeded();
		expect(canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root))).toBe(
			canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root)),
		);
		// Neither the root's path nor a read time is in the result.
		expect(canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root))).not.toContain(root);
	});

	it("changes nothing on disk: no bytes, no files, no directories", () => {
		const { root } = seeded();
		const before = treeHash(root);
		readEndoCockpitSnapshotV0(root);
		readEndoCockpitTimelineV0(root, { afterSequence: 3, limit: 4 });
		readEndoCockpitRegistryV0(root, ATTACHMENT);
		checkEndoCockpitSourceFreshnessV0(root, readEndoCockpitEventLogV0(root).source);
		expect(treeHash(root)).toBe(before);
	});

	it("pages by storage sequence with a stable, resumable cursor", () => {
		const { root, events } = seeded();
		const seen: string[] = [];
		let after = 0;
		for (let guard = 0; guard < 50; guard += 1) {
			const page = readEndoCockpitTimelineV0(root, { afterSequence: after, limit: 7 });
			expect(page.entries.length).toBeLessThanOrEqual(7);
			expect(page.entries.map((e) => e.storageSequence)).toEqual(page.entries.map((_, i) => after + i + 1));
			seen.push(...page.entries.map((e) => e.eventId));
			after = page.window.nextAfterSequence;
			if (!page.window.hasMore) break;
		}
		expect(seen).toEqual(events.map((e) => e.id));
		// Past the end is an empty window that says nothing more follows.
		const past = readEndoCockpitTimelineV0(root, { afterSequence: events.length + 10 });
		expect(past.entries).toEqual([]);
		expect(past.window).toMatchObject({ afterSequence: events.length + 10, hasMore: false });
	});

	it("rejects an invalid window rather than guessing", () => {
		const { root } = seeded();
		for (const options of [
			{ limit: 0 },
			{ limit: ENDO_COCKPIT_PAGE_MAX_LIMIT_V0 + 1 },
			{ limit: 1.5 },
			{ afterSequence: -1 },
			{ afterSequence: 0.5 },
		]) {
			expect(() => readEndoCockpitEventLogV0(root, options)).toThrow(TypeError);
		}
	});
});

describe("absent, empty, degraded and unopenable sources", () => {
	it("reads a root that does not exist without creating it, and says everything is absent", () => {
		const parent = tempRoot();
		const root = join(parent, "nowhere");
		const snapshot = readEndoCockpitSnapshotV0(root, { attachments: [ATTACHMENT] });
		expect(existsSync(root)).toBe(false);
		expect(snapshot.timeline.source.condition.state).toBe("absent");
		expect(snapshot.timeline.source.watermark).toEqual({ length: 0, lastEventId: null, prefixDigest: null });
		expect(snapshot.runtimes[0]!.identity.source.condition.state).toBe("absent");
		expect(snapshot.runtimes[0]!.identity.notes.map((n) => n.code)).toEqual(["source-not-projectable"]);
		expect(listEndoCockpitAttachmentsV0(root)).toEqual([]);
	});

	it("tells an empty log from an absent one", () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		writeFileSync(eventsLog(root), "");
		expect(readEndoCockpitEventLogV0(root).source.condition.state).toBe("empty");
	});

	it("an absent optional registry is not an error, and an invalid existing one is", () => {
		const root = tempRoot();
		ingestAll(root, [event("tool.started")]);
		expect(readEndoCockpitRegistryV0(root, ATTACHMENT).source.condition.state).toBe("absent");

		const invalid = tempRoot();
		appendFrame(registryLog(invalid), { kind: "state", record: { schemaVersion: "endo.capability-state.v999" } });
		const before = treeHash(invalid);
		const read = readEndoCockpitRegistryV0(invalid, ATTACHMENT);
		expect(read.source.condition).toMatchObject({
			state: "unopenable",
			error: { kind: "schema-unsupported-version" },
		});
		expect(read.source.condition.error!.message).not.toContain("v999");
		expect(read.source.watermark).toBeNull();
		expect(read.records).toBeNull();
		expect(treeHash(invalid)).toBe(before);
		const projected = readEndoCockpitSnapshotV0(invalid, { attachments: [ATTACHMENT] }).runtimes[0]!;
		expect(projected.capabilities.state).toBeNull();
		expect(projected.capabilities.notes.map((n) => n.code)).toEqual(["source-not-projectable"]);
	});

	it("reports a torn event-log tail as degraded, leaves it in place, and still serves the valid prefix", () => {
		const { root, events } = seeded();
		const tail = endoFrameBytesV0(new TextEncoder().encode(JSON.stringify(event("tool.started")))).subarray(0, 21);
		appendFileSync(eventsLog(root), tail);
		const before = treeHash(root);
		const timeline = readEndoCockpitTimelineV0(root, { limit: 1000 });
		expect(timeline.source.condition).toMatchObject({
			state: "degraded",
			sealedAt: null,
			error: null,
			tornTail: { bytes: 21 },
		});
		expect(timeline.source.condition.tornTail!.sha256).toBe(sha256HexV0(tail));
		expect(timeline.entries.map((e) => e.eventId)).toEqual(events.map((e) => e.id));
		expect(timeline.source.watermark!.length).toBe(events.length);
		// Not truncated, not preserved elsewhere: the read-only open repaired nothing.
		expect(treeHash(root)).toBe(before);
		expect(readdirNames(join(root, "events"))).toEqual(["events.log"]);
	});

	it("reports a log with only a torn tail as degraded, not empty", () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		writeFileSync(eventsLog(root), Buffer.from([0, 0, 0, 9, 1, 2]));
		const read = readEndoCockpitEventLogV0(root);
		expect(read.source.condition.state).toBe("degraded");
		expect(read.source.watermark).toEqual({ length: 0, lastEventId: null, prefixDigest: null });
	});

	it("reports a corrupt frame as sealed, serves the verified prefix only, and changes nothing", () => {
		const { root, events } = seeded();
		flipByte(eventsLog(root), frameStart(eventsLog(root), 5) + 8);
		const before = treeHash(root);
		const timeline = readEndoCockpitTimelineV0(root, { limit: 1000 });
		expect(timeline.source.condition).toMatchObject({ state: "degraded", sealedAt: 6, tornTail: null });
		expect(timeline.entries.map((e) => e.eventId)).toEqual(events.slice(0, 5).map((e) => e.id));
		expect(timeline.source.watermark).toEqual({
			length: 5,
			lastEventId: events[4]!.id,
			prefixDigest: idsDigest(events.slice(0, 5)),
		});
		expect(treeHash(root)).toBe(before);
	});

	it("a degraded registry stays degraded and read-only", () => {
		const { root } = seeded();
		appendFileSync(registryLog(root), Buffer.from([0, 0, 1, 0, 7]));
		const before = treeHash(root);
		const read = readEndoCockpitRegistryV0(root, ATTACHMENT);
		expect(read.source.condition).toMatchObject({ state: "degraded", tornTail: { bytes: 5 } });
		expect(read.records!.fingerprint).toHaveLength(1);
		expect(treeHash(root)).toBe(before);
	});

	it("an event log that decodes but violates the event rules is unopenable, never empty, and untouched", () => {
		const root = tempRoot();
		const path = eventsLog(root);
		mkdirSync(join(root, "events"));
		const dup = event("tool.started", {}, { id: "endo.event.dup.9" });
		const log = createEndoFrameLogV0(path);
		log.append(new TextEncoder().encode(canonicalEndoJsonV0(dup)));
		log.append(new TextEncoder().encode(canonicalEndoJsonV0(dup)));
		const before = treeHash(root);
		const read = readEndoCockpitEventLogV0(root);
		expect(read.source.condition).toMatchObject({ state: "unopenable", error: { kind: "invalid-store" } });
		expect(read.source.condition.error!.message).toContain("duplicate event id");
		expect(read.source.watermark).toBeNull();
		expect(read.events).toEqual([]);
		const projected = readEndoCockpitTimelineV0(root);
		expect(projected.notes.map((n) => n.code)).toEqual(["source-not-projectable"]);
		expect(treeHash(root)).toBe(before);
	});

	it("an event of an unknown schema version makes the log unopenable without echoing the version", () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		createEndoFrameLogV0(eventsLog(root)).append(
			new TextEncoder().encode(JSON.stringify({ ...event("tool.started"), schemaVersion: "endo.event.v999" })),
		);
		const condition = readEndoCockpitEventLogV0(root).source.condition;
		expect(condition).toMatchObject({ state: "unopenable", error: { kind: "schema-unsupported-version" } });
		expect(condition.error!.message).toBe("a stored record declares a schema version this reader does not support");
	});

	it("a registry state whose status contradicts its classification is refused on open, not repaired", () => {
		const root = tempRoot();
		const { fingerprint, state } = specimen();
		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		registry.append("fingerprint", fingerprint);
		const bad = structuredClone(state);
		bad.capabilities[0]!.classification = "UNAVAILABLE";
		appendFrame(registryLog(root), { kind: "state", record: bad });
		expect(readEndoCockpitRegistryV0(root, ATTACHMENT).source.condition.state).toBe("unopenable");
	});

	it("a dangling symlink where the log should be is unopenable, not absent", () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		symlinkSync(join(root, "no-such-target"), eventsLog(root));
		const condition = readEndoCockpitEventLogV0(root).source.condition;
		expect(condition).toMatchObject({ state: "unopenable", error: { kind: "unreadable" } });
	});

	it("a log path that is not a file is unopenable", () => {
		const root = tempRoot();
		mkdirSync(eventsLog(root), { recursive: true });
		expect(readEndoCockpitEventLogV0(root).source.condition.state).toBe("unopenable");
	});

	it("lists only well-formed registry directories, in code-unit order", () => {
		const root = tempRoot();
		for (const name of ["pi.default", "acp.omp", "Not-Valid", "zeta"])
			mkdirSync(join(root, "harness", name), { recursive: true });
		writeFileSync(join(root, "harness", "file.txt"), "x");
		expect(listEndoCockpitAttachmentsV0(root)).toEqual(["acp.omp", "pi.default", "zeta"]);
	});
});

function readdirNames(dir: string): string[] {
	return readdirSync(dir).sort();
}

describe("independent histories and freshness", () => {
	it("a registry update does not advance the event position, and an event append does not move the registry's", () => {
		const { root } = seeded();
		const first = readEndoCockpitSnapshotV0(root);
		const identity = first.runtimes[0]!.identity.source;

		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		registry.append("change", changeRecord());
		registry.append("notification", notificationRecord());
		const second = readEndoCockpitSnapshotV0(root);
		expect(second.timeline.source).toEqual(first.timeline.source);
		expect(second.runtimes[0]!.identity.source.watermark).not.toEqual(identity.watermark);
		expect(second.runtimes[0]!.identity.source.watermark!.counts).toMatchObject({ change: 1, notification: 1 });

		const store = createEndoDurableEventStoreV0(root);
		store.ingest(event("tool.started", { toolName: "late" }, { id: "endo.event.late.1" }));
		store.close();
		const third = readEndoCockpitSnapshotV0(root);
		expect(third.timeline.source.watermark!.length).toBe(first.timeline.source.watermark!.length! + 1);
		expect(third.runtimes[0]!.identity.source).toEqual(second.runtimes[0]!.identity.source);
		expect(third.consistency).toBe("independent-sources");
	});

	it("tells a consumer whether to continue, re-read, or start over", () => {
		const { root, events } = seeded();
		const held = readEndoCockpitEventLogV0(root, { limit: 1000 }).source;
		const heldRegistry = readEndoCockpitRegistryV0(root, ATTACHMENT).source;
		expect(checkEndoCockpitSourceFreshnessV0(root, held)).toBe("unchanged");
		expect(checkEndoCockpitSourceFreshnessV0(root, heldRegistry)).toBe("unchanged");

		const store = createEndoDurableEventStoreV0(root);
		store.ingest(event("tool.finished", {}, { id: "endo.event.late.2" }));
		store.close();
		expect(checkEndoCockpitSourceFreshnessV0(root, held)).toBe("advanced");
		// Continuing from the old length yields exactly the new event.
		const next = readEndoCockpitTimelineV0(root, { afterSequence: held.watermark!.length });
		expect(next.entries.map((e) => e.eventId)).toEqual(["endo.event.late.2"]);
		expect(checkEndoCockpitSourceFreshnessV0(root, heldRegistry)).toBe("unchanged");

		openEndoHarnessRegistryV0(root, ATTACHMENT).append("change", changeRecord());
		expect(checkEndoCockpitSourceFreshnessV0(root, heldRegistry)).toBe("changed");

		// A rewritten log: same length as before, a different event at the old position.
		const other = tempRoot();
		ingestAll(other, [
			...events.slice(0, events.length - 1),
			event("tool.started", {}, { id: "endo.event.other.1" }),
		]);
		expect(checkEndoCockpitSourceFreshnessV0(other, held)).toBe("diverged");
		// The same length and the same last event, but an event in the middle replaced: only a prefix check sees it.
		const spliced = tempRoot();
		ingestAll(spliced, [
			...events.slice(0, 2),
			event("tool.started", {}, { id: "endo.event.other.2" }),
			...events.slice(3),
			event("tool.finished", {}, { id: "endo.event.late.2" }),
		]);
		expect(checkEndoCockpitSourceFreshnessV0(spliced, held)).toBe("diverged");
		const shorter = tempRoot();
		ingestAll(shorter, events.slice(0, 3));
		expect(checkEndoCockpitSourceFreshnessV0(shorter, held)).toBe("shrunk");
		expect(checkEndoCockpitSourceFreshnessV0(tempRoot(), held)).toBe("shrunk");

		// A torn tail appearing at the same length is a change of condition, not an advance.
		const torn = readEndoCockpitEventLogV0(root, { limit: 1000 }).source;
		appendFileSync(eventsLog(root), Buffer.from([0, 0, 0, 40, 1]));
		expect(checkEndoCockpitSourceFreshnessV0(root, torn)).toBe("changed");

		const broken = tempRoot();
		mkdirSync(join(broken, "events"));
		writeFileSync(eventsLog(broken), "not a frame log, long enough to be a damaged length prefix....");
		expect(checkEndoCockpitSourceFreshnessV0(broken, held)).not.toBe("unchanged");
	});
});

describe("contract totality over valid source records", () => {
	it("projects every committed fake-Pi lifecycle recording under the strict contract", () => {
		for (const name of ["completes", "killed-and-resumed", "stop-mid-turn"]) {
			const root = tempRoot();
			const events = lifecycleEvents(name);
			ingestAll(root, events);
			const snapshot = readEndoCockpitSnapshotV0(root, { limit: events.length });
			expect(validateEndoCockpitSnapshotV0(snapshot), name).not.toBeNull();
			expect(
				snapshot.timeline.entries.map((e) => e.eventId),
				name,
			).toEqual(events.map((e) => e.id));
		}
	});

	it("accepts the extremes the event envelope accepts: a long producer name and a very large producer sequence", () => {
		const root = tempRoot();
		const long = "p".repeat(1000);
		ingestAll(root, [
			event("tool.started", {}, { producer: long, sequence: Number.MAX_SAFE_INTEGER * 4 }),
			event("tool.finished", {}, { producer: "short" }),
		]);
		const timeline = readEndoCockpitTimelineV0(root);
		// A producer name outside the shape Endophasia's producers use is withheld whole, not cut.
		expect(timeline.entries[0]!.producer).toBe("withheld: looks like a path, address or credential");
		expect(timeline.entries[0]!.producerSequence).toBe(Number.MAX_SAFE_INTEGER * 4);
		expect(timeline.entries[1]!.producer).toBe("short");
	});

	it("keeps a hostile schema version to a short, escaped, non-empty message", () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		const hostile = `endo.event.v${"\u0001 ".repeat(200)}`;
		createEndoFrameLogV0(eventsLog(root)).append(
			new TextEncoder().encode(JSON.stringify({ ...event("tool.started"), schemaVersion: hostile })),
		);
		const timeline = readEndoCockpitTimelineV0(root);
		const message = timeline.source.condition.error!.message;
		expect(message.length).toBeGreaterThan(0);
		expect(message.length).toBeLessThanOrEqual(512);
		expect(message).not.toMatch(/[\u0000-\u001f\u2028\u2029]/);
	});
});

describe("freshness binds event contents (PR #57 review)", () => {
	/** The same events with one replaced event keeping its id: only its contents differ. */
	function replaced(events: ReturnType<typeof lifecycleEvents>, at: number, edit: (copy: any) => void) {
		return events.map((item, index) => {
			if (index !== at) return item;
			const copy = structuredClone(item) as any;
			edit(copy);
			return copy;
		});
	}

	it("restates the digest as one fixed-width line per event over its canonical JSON", () => {
		const { root, events } = seeded();
		const source = readEndoCockpitEventLogV0(root, { limit: 1 }).source;
		expect(source.watermark!.prefixDigest).toBe(idsDigest(events));
		const one = tempRoot();
		ingestAll(one, events.slice(0, 1));
		expect(readEndoCockpitEventLogV0(one).source.watermark!.prefixDigest).toBe(
			sha256HexV0(`${sha256HexV0(canonicalEndoJsonV0(events[0]))}\n`),
		);
	});

	it("tells a replaced event from the original when its id, the length and the order are unchanged", () => {
		const { root, events } = seeded();
		const held = readEndoCockpitEventLogV0(root, { limit: 1000 }).source;
		const edits: [string, (copy: any) => void][] = [
			[
				"payload",
				(c) => {
					c.payload = { ...c.payload, replaced: true };
				},
			],
			[
				"kind",
				(c) => {
					c.kind = "tool.finished";
				},
			],
			[
				"recorded time",
				(c) => {
					c.at = "2030-01-01T00:00:00Z";
				},
			],
			[
				"producer sequence",
				(c) => {
					c.sequence = c.sequence + 1000;
				},
			],
			[
				"coordinates",
				(c) => {
					c.coordinates = { sessionId: "endo.session.test.replaced" };
				},
			],
			[
				"source class",
				(c) => {
					c.source = c.source === "runtime-fact" ? "interpretation" : "runtime-fact";
				},
			],
		];
		for (const at of [0, 2, events.length - 1]) {
			for (const [name, edit] of edits) {
				const other = tempRoot();
				const changed = replaced(events, at, edit);
				expect(changed[at]!.id).toBe(events[at]!.id);
				ingestAll(other, changed);
				const now = readEndoCockpitEventLogV0(other).source.watermark!;
				expect(now.length, `${name}@${at}`).toBe(held.watermark!.length);
				expect(now.lastEventId, `${name}@${at}`).toBe(held.watermark!.lastEventId);
				expect(checkEndoCockpitSourceFreshnessV0(other, held), `${name}@${at}`).toBe("diverged");
			}
		}
		expect(checkEndoCockpitSourceFreshnessV0(root, held)).toBe("unchanged");
	});

	it("reports a changed prefix followed by more events as diverged, not advanced", () => {
		const { root, events } = seeded();
		const held = readEndoCockpitEventLogV0(root, { limit: 1000 }).source;
		const other = tempRoot();
		ingestAll(other, [
			...replaced(events, 1, (c) => {
				c.payload = { ...c.payload, replaced: true };
			}),
			event("tool.finished", {}, { id: "endo.event.more.1" }),
			event("tool.finished", {}, { id: "endo.event.more.2" }),
		]);
		expect(readEndoCockpitEventLogV0(other).source.watermark!.length).toBe(held.watermark!.length + 2);
		expect(checkEndoCockpitSourceFreshnessV0(other, held)).toBe("diverged");
		// The same appends over the unchanged prefix are an advance.
		const advanced = tempRoot();
		ingestAll(advanced, [
			...events,
			event("tool.finished", {}, { id: "endo.event.more.1" }),
			event("tool.finished", {}, { id: "endo.event.more.2" }),
		]);
		expect(checkEndoCockpitSourceFreshnessV0(advanced, held)).toBe("advanced");
	});

	it("checks the held prefix, not the whole log, and still reports a shorter log as shrunk", () => {
		const { root, events } = seeded();
		const half = readEndoCockpitEventLogV0(root, { limit: 1000 }).source;
		const earlier = tempRoot();
		ingestAll(earlier, events.slice(0, 3));
		const held = readEndoCockpitEventLogV0(earlier).source;
		// A later suffix does not matter when the held prefix is intact.
		expect(checkEndoCockpitSourceFreshnessV0(root, held)).toBe("advanced");
		const shorter = tempRoot();
		ingestAll(shorter, events.slice(0, 2));
		expect(checkEndoCockpitSourceFreshnessV0(shorter, half)).toBe("shrunk");
	});

	it("changes nothing on disk while checking", () => {
		const { root, events } = seeded();
		const held = readEndoCockpitEventLogV0(root, { limit: 1000 }).source;
		const before = treeHash(root);
		checkEndoCockpitSourceFreshnessV0(root, held);
		const other = tempRoot();
		ingestAll(
			other,
			replaced(events, 0, (c) => {
				c.payload = { replaced: true };
			}),
		);
		const otherBefore = treeHash(other);
		expect(checkEndoCockpitSourceFreshnessV0(other, held)).toBe("diverged");
		expect(treeHash(other)).toBe(otherBefore);
		expect(treeHash(root)).toBe(before);
	});
});

describe("source condition messages (PR #57 audit)", () => {
	function unsupported(label: string) {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		createEndoFrameLogV0(eventsLog(root)).append(
			new TextEncoder().encode(JSON.stringify({ ...event("tool.started"), schemaVersion: label })),
		);
		return { root, condition: readEndoCockpitEventLogV0(root).source.condition };
	}

	it("never echoes a declared schema version: the message is fixed text per failure kind", () => {
		const FIXED = "a stored record declares a schema version this reader does not support";
		const hostile = [
			"endo.event.v999",
			`/home/${CANARY}/secret`,
			`token=${CANARY}`,
			`ghp_${"A".repeat(36)}`,
			"AKIAABCDEFGHIJKLMNOP",
			`xyz-${"9".repeat(40)}`,
			`a sentence with ${CANARY} in it`,
			`x\u0007${CANARY}`,
			"v".repeat(5000),
		];
		for (const label of hostile) {
			const { root, condition } = unsupported(label);
			expect(condition.error, label).toEqual({ kind: "schema-unsupported-version", message: FIXED });
			expect(JSON.stringify(condition), label).not.toContain(root);
		}
		// The other ways a record can fail its schema version are fixed text too.
		const failures: [string, unknown, string][] = [
			[
				"missing-version",
				{ ...event("tool.started"), schemaVersion: undefined },
				"a stored record declares no schema version",
			],
			[
				"version-not-string",
				{ ...event("tool.started"), schemaVersion: { [CANARY]: 1 } },
				"a stored record declares a schema version that is not a string",
			],
			[
				"invalid",
				{ ...event("tool.started"), id: `/home/${CANARY}` },
				"a stored record does not satisfy the schema version it declares",
			],
		];
		for (const [kind, record, message] of failures) {
			const root = tempRoot();
			mkdirSync(join(root, "events"));
			createEndoFrameLogV0(eventsLog(root)).append(new TextEncoder().encode(JSON.stringify(record)));
			const condition = readEndoCockpitEventLogV0(root).source.condition;
			expect(condition.error, kind).toEqual({ kind: `schema-${kind}`, message });
		}
		// A registry record behaves the same way.
		const root = tempRoot();
		const { fingerprint } = specimen();
		mkdirSync(join(root, "harness", ATTACHMENT), { recursive: true });
		appendFrame(registryLog(root), {
			kind: "fingerprint",
			record: { ...fingerprint, schemaVersion: `ghp_${"B".repeat(36)}` },
		});
		const condition = readEndoCockpitRegistryV0(root, ATTACHMENT).source.condition;
		expect(condition.error).toEqual({ kind: "schema-unsupported-version", message: FIXED });
	});
});

describe("freshness without a held position (PR #57 review round 2)", () => {
	it("is unavailable, not changed, when the held source had no watermark", () => {
		const { root } = seeded();
		const heldLog = readEndoCockpitEventLogV0(root, { limit: 1 }).source;
		const noPositionLog = {
			...heldLog,
			condition: {
				state: "unopenable" as const,
				tornTail: null,
				sealedAt: null,
				error: { kind: "invalid-store", message: "bad" },
			},
			watermark: null,
		};
		expect(checkEndoCockpitSourceFreshnessV0(root, noPositionLog)).toBe("unavailable");
		const heldRegistry = readEndoCockpitRegistryV0(root, ATTACHMENT).source;
		const noPositionRegistry = { ...heldRegistry, condition: noPositionLog.condition, watermark: null };
		expect(checkEndoCockpitSourceFreshnessV0(root, noPositionRegistry)).toBe("unavailable");
		// With a position the ordinary comparison still applies.
		expect(checkEndoCockpitSourceFreshnessV0(root, heldLog)).toBe("unchanged");
		expect(checkEndoCockpitSourceFreshnessV0(root, heldRegistry)).toBe("unchanged");
	});
});

describe("unreadable files are not empty files (PR #57 review round 3)", () => {
	// Real permission failures need an unprivileged process: root reads any file.
	const unprivileged = typeof process.getuid === "function" && process.getuid() !== 0;
	const it2 = unprivileged ? it : it.skip;

	function denied(path: string, content: Uint8Array | string): () => void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
		chmodSync(path, 0o000);
		return () => chmodSync(path, 0o600);
	}

	it2("an event log that cannot be read is unopenable at any size, never empty, and nothing is changed", () => {
		for (const content of ["", "x", "garbage ".repeat(40)]) {
			const root = tempRoot();
			const restore = denied(eventsLog(root), content);
			try {
				const before = statSync(eventsLog(root));
				const read = readEndoCockpitEventLogV0(root);
				expect(read.source.condition, `${content.length}`).toEqual({
					state: "unopenable",
					tornTail: null,
					sealedAt: null,
					error: { kind: "unreadable", message: "the log cannot be read (EACCES)" },
				});
				expect(read.source.watermark).toBeNull();
				expect(read.events).toEqual([]);
				expect(JSON.stringify(read.source)).not.toContain(root);
				expect(readEndoCockpitTimelineV0(root).notes.map((n) => n.code)).toEqual(["source-not-projectable"]);
				const after = statSync(eventsLog(root));
				expect([after.size, after.mode, after.mtimeMs]).toEqual([before.size, before.mode, before.mtimeMs]);
			} finally {
				restore();
			}
		}
	});

	it2("a registry that cannot be read is unopenable at any size, consistently with the event log", () => {
		for (const content of ["", "x", "garbage ".repeat(40)]) {
			const root = tempRoot();
			const restore = denied(registryLog(root), content);
			try {
				const read = readEndoCockpitRegistryV0(root, ATTACHMENT);
				expect(read.source.condition, `${content.length}`).toEqual({
					state: "unopenable",
					tornTail: null,
					sealedAt: null,
					error: { kind: "unreadable", message: "the log cannot be read (EACCES)" },
				});
				expect(read.source.watermark).toBeNull();
				expect(read.records).toBeNull();
				expect(JSON.stringify(read.source)).not.toContain(root);
			} finally {
				restore();
			}
		}
	});

	it2("freshness treats an unreadable source as unavailable", () => {
		const { root } = seeded();
		const heldLog = readEndoCockpitEventLogV0(root, { limit: 1 }).source;
		const heldRegistry = readEndoCockpitRegistryV0(root, ATTACHMENT).source;
		chmodSync(eventsLog(root), 0o000);
		chmodSync(registryLog(root), 0o000);
		try {
			expect(checkEndoCockpitSourceFreshnessV0(root, heldLog)).toBe("unavailable");
			expect(checkEndoCockpitSourceFreshnessV0(root, heldRegistry)).toBe("unavailable");
		} finally {
			chmodSync(eventsLog(root), 0o600);
			chmodSync(registryLog(root), 0o600);
		}
		expect(checkEndoCockpitSourceFreshnessV0(root, heldLog)).toBe("unchanged");
	});

	it("a file that is really empty is empty, and one that is really absent is absent", () => {
		const empty = tempRoot();
		mkdirSync(join(empty, "events"));
		writeFileSync(eventsLog(empty), "");
		expect(readEndoCockpitEventLogV0(empty).source.condition.state).toBe("empty");
		expect(readEndoCockpitEventLogV0(tempRoot()).source.condition.state).toBe("absent");
		const emptyRegistry = tempRoot();
		mkdirSync(join(emptyRegistry, "harness", ATTACHMENT), { recursive: true });
		writeFileSync(registryLog(emptyRegistry), "");
		expect(readEndoCockpitRegistryV0(emptyRegistry, ATTACHMENT).source.condition.state).toBe("empty");
	});
});
