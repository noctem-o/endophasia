// The store-to-projection path: real durable stores on disk (the committed fake-Pi lifecycle recordings and the committed
// Pi 1.0.0 specimen), opened read-only by the cockpit reader and projected. The fixtures are FAKE-Pi recordings and a
// real-Pi specimen replayed into a store; they establish that the bridge reads and projects what the substrate recorded,
// not anything about a live runtime.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
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

/** What the watermark's prefix digest is: sha256 of the event ids in storage order, one per line. */
const idsDigest = (events: readonly { id: string }[]) => sha256HexV0(events.map((e) => `${e.id}\n`).join(""));
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
		expect(read.source.condition.error!.message).toContain("v999");
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

	it("an event of an unknown schema version makes the log unopenable and names the version", () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		createEndoFrameLogV0(eventsLog(root)).append(
			new TextEncoder().encode(JSON.stringify({ ...event("tool.started"), schemaVersion: "endo.event.v999" })),
		);
		const condition = readEndoCockpitEventLogV0(root).source.condition;
		expect(condition).toMatchObject({ state: "unopenable", error: { kind: "schema-unsupported-version" } });
		expect(condition.error!.message).toContain("endo.event.v999");
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
		expect(timeline.entries[0]!.producer).toHaveLength(512);
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
