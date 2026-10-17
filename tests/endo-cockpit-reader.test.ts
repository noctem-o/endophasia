// The store-to-projection path: real durable stores on disk (the committed fake-Pi lifecycle recordings and the committed
// Pi 1.0.0 specimen), opened read-only by the cockpit reader and projected. The fixtures are FAKE-Pi recordings and a
// real-Pi specimen replayed into a store; they establish that the bridge reads and projects what the substrate recorded,
// not anything about a live runtime.
import { createHmac } from "node:crypto";
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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { projectEndoCockpitSessionTimelineV0 as projectRaw } from "../cockpit/projections/session-timeline.ts";
import {
	checkEndoCockpitSourceFreshnessV0 as checkRaw,
	readEndoCockpitEventLogV0 as readLogRaw,
	readEndoCockpitRegistryV0 as readRegistryRaw,
} from "../cockpit/reader.ts";
import { readEndoCockpitSnapshotV0 as readSnapshotRaw } from "../cockpit/snapshot.ts";
import {
	ENDO_COCKPIT_SOURCE_ERRORS_V0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitSessionTimelineV0,
} from "../protocol/cockpit.ts";
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
import {
	checkEndoCockpitSourceFreshnessV0,
	ENDO_COCKPIT_PAGE_MAX_LIMIT_V0,
	listEndoCockpitAttachmentsV0,
	OTHER_KEY,
	projectEndoCockpitCapabilityStateV0,
	projectEndoCockpitSessionTimelineV0,
	readEndoCockpitEventLogV0,
	readEndoCockpitRegistryV0,
	readEndoCockpitRuntimeV0,
	readEndoCockpitSnapshotV0,
	readEndoCockpitTimelineV0,
	TEST_KEY,
	validateEndoCockpitSnapshotV0,
} from "./cockpit-keyed.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const FIXTURE = "killed-and-resumed";

/**
 * The internal chain (never published): the sha256 over one line per event in storage order, each line the hex sha256 of
 * the event's canonical JSON and a newline.
 */
const rawChain = (events: readonly unknown[]) =>
	sha256HexV0(events.map((e) => `${sha256HexV0(canonicalEndoJsonV0(e))}\n`).join(""));
/** What the watermark's prefix digest is, restated independently: an HMAC under the fixture key of the chain. */
const idsDigest = (events: readonly unknown[]) =>
	createHmac("sha256", Buffer.alloc(32, 0x5a))
		.update(
			canonicalEndoJsonV0({
				purpose: "endo.cockpit.event-prefix.v0",
				length: events.length,
				chain: rawChain(events),
			}),
		)
		.digest("hex");
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
			watermark: {
				length: events.length,
				lastEventId: events.at(-1)!.id,
				prefixDigest: idsDigest(events),
				keyId: TEST_KEY.keyId,
			},
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
		).toEqual(
			state.capabilities.map((c) => [
				c.capability,
				c.status,
				c.classification,
				// Free text over the 256-character bound is withheld whole.
				c.reason.length > 256 ? "withheld: looks like a path, address or credential" : c.reason,
			]),
		);
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
		expect(snapshot.timeline.source.watermark).toEqual({
			length: 0,
			lastEventId: null,
			prefixDigest: null,
			keyId: TEST_KEY.keyId,
		});
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
		// The token is the HMAC under the key of the purpose, the length and the unkeyed hash of the bytes; the unkeyed
		// hash itself is not published.
		expect(timeline.source.condition.tornTail!.digest).toBe(
			createHmac("sha256", Buffer.alloc(32, 0x5a))
				.update(canonicalEndoJsonV0({ purpose: "endo.cockpit.torn-tail.v0", bytes: 21, sha256: sha256HexV0(tail) }))
				.digest("hex"),
		);
		expect(JSON.stringify(timeline)).not.toContain(sha256HexV0(tail));
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
		expect(read.source.watermark).toEqual({
			length: 0,
			lastEventId: null,
			prefixDigest: null,
			keyId: TEST_KEY.keyId,
		});
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
			keyId: TEST_KEY.keyId,
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
		expect(read.source.condition).toMatchObject({ state: "unopenable", error: { kind: "duplicate-id" } });
		expect(read.source.condition.error!.message).toBe("a stored record repeats the identifier of an earlier record");
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
		expect(condition).toMatchObject({ state: "unopenable", error: { kind: "path-dangling-symlink" } });
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
		expect(readEndoCockpitEventLogV0(one).source.watermark!.prefixDigest).toBe(idsDigest(events.slice(0, 1)));
		// The plain chain is internal: it appears nowhere in the published source.
		expect(JSON.stringify(source)).not.toContain(rawChain(events));
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
				error: { kind: "invalid-store" as const, message: "the store could not be opened" },
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
					error: { kind: "unreadable", message: "the log file exists but cannot be read" },
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
					error: { kind: "unreadable", message: "the log file exists but cannot be read" },
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

describe("open failures never quote the store (PR #57 review round 4)", () => {
	it("a repeated credential-shaped identifier gives the fixed category text, for events and for registry records", () => {
		const hostileId = `endo.event.ghp_${CANARY}${CANARY}`;
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		const dup = event("tool.started", {}, { id: hostileId });
		const log = createEndoFrameLogV0(eventsLog(root));
		log.append(new TextEncoder().encode(canonicalEndoJsonV0(dup)));
		log.append(new TextEncoder().encode(canonicalEndoJsonV0(dup)));
		const condition = readEndoCockpitEventLogV0(root).source.condition;
		expect(condition.error).toEqual({
			kind: "duplicate-id",
			message: "a stored record repeats the identifier of an earlier record",
		});
		expect(JSON.stringify(condition)).not.toContain(CANARY);

		const registryRoot = tempRoot();
		const { fingerprint } = specimen();
		mkdirSync(join(registryRoot, "harness", ATTACHMENT), { recursive: true });
		const twice = { ...fingerprint, id: `endo.evidence.Tok_ghp_${CANARY}${CANARY}` };
		appendFrame(registryLog(registryRoot), { kind: "fingerprint", record: twice });
		appendFrame(registryLog(registryRoot), { kind: "fingerprint", record: twice });
		const registry = readEndoCockpitRegistryV0(registryRoot, ATTACHMENT).source.condition;
		expect(registry.error).toEqual({
			kind: "duplicate-id",
			message: "a stored record repeats the identifier of an earlier record",
		});
		expect(JSON.stringify(registry)).not.toContain(CANARY);
	});

	it("every public error is one of the closed set, each with exactly its fixed message", () => {
		for (const kind of Object.keys(ENDO_COCKPIT_SOURCE_ERRORS_V0)) {
			const message = ENDO_COCKPIT_SOURCE_ERRORS_V0[kind as keyof typeof ENDO_COCKPIT_SOURCE_ERRORS_V0];
			expect(message.length).toBeGreaterThan(0);
			expect(message.length).toBeLessThanOrEqual(512);
		}
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		symlinkSync(join(root, "no-such-target"), eventsLog(root));
		const condition = readEndoCockpitEventLogV0(root).source.condition;
		expect(condition.error).toEqual({
			kind: "path-dangling-symlink",
			message: ENDO_COCKPIT_SOURCE_ERRORS_V0["path-dangling-symlink"],
		});
		expect(JSON.stringify(condition)).not.toContain(root);
	});

	it("presents a non-public identifier as one consistent alias and still pages, validates and checks freshness", () => {
		const root = tempRoot();
		const events = [
			event("tool.started", {}, { id: "endo.event.plain.1" }),
			event("tool.finished", {}, { id: `endo.event.Tok_${CANARY}` }),
		];
		ingestAll(root, events);
		const timeline = readEndoCockpitTimelineV0(root);
		const [first, last] = timeline.entries;
		expect(first!.eventId).toBe("endo.event.plain.1");
		expect(last!.eventId).toMatch(/^endo\.event\.withheld-[0-9a-f]{32}$/);
		expect(timeline.source.watermark!.lastEventId).toBe(last!.eventId);
		// Addressability does not depend on the identifier: the position does.
		expect(last!.storageSequence).toBe(2);
		expect(readEndoCockpitTimelineV0(root, { afterSequence: 1 }).entries.map((e) => e.eventId)).toEqual([
			last!.eventId,
		]);
		expect(validateEndoCockpitSnapshotV0(JSON.parse(JSON.stringify(readEndoCockpitSnapshotV0(root))))).not.toBeNull();
		expect(checkEndoCockpitSourceFreshnessV0(root, timeline.source)).toBe("unchanged");
		expect(JSON.stringify(timeline)).not.toContain(CANARY);
	});
});

describe("generated aliases never collide with source identifiers (PR #57 review round 5)", () => {
	const aliasOf = (id: string) => `${id.split(".").slice(0, 2).join(".")}.withheld-${sha256HexV0(id).slice(0, 32)}`;

	it("reads a store holding an identifier and another identifier equal to its alias, across events and a registry", () => {
		const a = "endo.event.Tok_collide";
		const b = aliasOf(a);
		const root = tempRoot();
		ingestAll(root, [
			event("tool.started", {}, { id: a }),
			event("tool.finished", {}, { id: b }),
			{ ...event("agent.settled", {}, { id: "endo.event.plain.1" }), derivedFrom: [a, b] },
		]);
		const { fingerprint, state } = specimen();
		const f = "endo.evidence.Tok_fp";
		const g = aliasOf(f);
		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		registry.append("fingerprint", { ...fingerprint, id: f });
		registry.append("fingerprint", {
			...fingerprint,
			id: g,
			observedAt: "2026-10-04T10:00:00.000Z",
			identity: { ...fingerprint.identity, digest: "d".repeat(64) },
		});
		registry.append("state", { ...state, fingerprintId: g, at: "2026-10-04T10:00:01.000Z" });
		const before = treeHash(root);
		const snapshot = readEndoCockpitSnapshotV0(root);
		expect(validateEndoCockpitSnapshotV0(JSON.parse(JSON.stringify(snapshot)))).not.toBeNull();
		const ids = snapshot.timeline.entries.map((e) => e.eventId);
		expect(new Set(ids).size).toBe(3);
		expect(snapshot.timeline.entries[2]!.derivedFrom).toEqual([ids[0], ids[1]]);
		expect(snapshot.timeline.source.watermark!.lastEventId).toBe(ids[2]);
		const identity = snapshot.runtimes[0]!.identity;
		expect(identity.current!.id).not.toBe(identity.previousDifferent!.id);
		expect(snapshot.runtimes[0]!.capabilities.state!.fingerprintId).toBe(identity.current!.id);
		expect(checkEndoCockpitSourceFreshnessV0(root, snapshot.timeline.source)).toBe("unchanged");
		expect(checkEndoCockpitSourceFreshnessV0(root, identity.source)).toBe("unchanged");
		expect(treeHash(root)).toBe(before);
	});
});

describe("sealed positions and empty registry digests (sixth review round)", () => {
	const withSeal = (value: any, sealedAt: number) => {
		const copy = structuredClone(value);
		copy.source.condition.sealedAt = sealedAt;
		return copy;
	};
	const capabilitiesOf = (root: string) =>
		projectEndoCockpitCapabilityStateV0(readEndoCockpitRegistryV0(root, ATTACHMENT));

	it("an event log sealed after a verified prefix names the frame right after it, and no other", () => {
		const { root } = seeded();
		flipByte(eventsLog(root), frameStart(eventsLog(root), 5) + 8);
		const timeline = readEndoCockpitTimelineV0(root, { limit: 1000 });
		expect(timeline.source.watermark!.length).toBe(5);
		expect(timeline.source.condition.sealedAt).toBe(6);
		expect(validateEndoCockpitSnapshotV0(readEndoCockpitSnapshotV0(root, { limit: 1000 }))).not.toBeNull();
		for (const wrong of [1, 5, 7, 100]) {
			const bad = structuredClone(timeline);
			bad.source.condition.sealedAt = wrong;
			expect(validateEndoCockpitSessionTimelineV0(bad), `sealedAt ${wrong}`).toBeNull();
		}
		expect(validateEndoCockpitSessionTimelineV0(timeline)).not.toBeNull();
	});

	it("an event log whose first frame is corrupt is sealed at 1 with a zero-length prefix", () => {
		const { root } = seeded();
		flipByte(eventsLog(root), 8);
		const before = treeHash(root);
		const timeline = readEndoCockpitTimelineV0(root);
		expect(treeHash(root)).toBe(before);
		expect(timeline.source.condition).toMatchObject({ state: "degraded", sealedAt: 1 });
		expect(timeline.source.watermark!.length).toBe(0);
		expect(validateEndoCockpitSessionTimelineV0(timeline)).not.toBeNull();
		const bad = structuredClone(timeline);
		bad.source.condition.sealedAt = 2;
		expect(validateEndoCockpitSessionTimelineV0(bad)).toBeNull();
	});

	it("a torn tail is not a seal: it carries no position, and a sealed position carries no torn tail requirement", () => {
		const { root, events } = seeded();
		appendFileSync(eventsLog(root), Buffer.from([0, 0, 0, 9, 1, 2]));
		const timeline = readEndoCockpitTimelineV0(root, { limit: 1000 });
		expect(timeline.source.condition).toMatchObject({ state: "degraded", sealedAt: null });
		expect(timeline.source.condition.tornTail).not.toBeNull();
		expect(timeline.source.watermark!.length).toBe(events.length);
		expect(validateEndoCockpitSessionTimelineV0(timeline)).not.toBeNull();
	});

	it("a registry sealed after n verified records names record n + 1; a zero prefix names 1", () => {
		const { root } = seeded();
		const total = readEndoCockpitRegistryV0(root, ATTACHMENT).records!;
		const n = total.fingerprint.length + total.evidence.length + total.state.length;
		expect(n).toBeGreaterThan(1);
		flipByte(registryLog(root), frameStart(registryLog(root), n - 1) + 8);
		const sealed = capabilitiesOf(root);
		expect(sealed.source.condition).toMatchObject({ state: "degraded", sealedAt: n });
		expect(validateEndoCockpitCapabilityStateV0(sealed)).not.toBeNull();
		for (const wrong of [1, n - 1, n + 1, 1000]) {
			expect(validateEndoCockpitCapabilityStateV0(withSeal(sealed, wrong)), `sealedAt ${wrong}`).toBeNull();
		}

		const zero = seeded().root;
		flipByte(registryLog(zero), 8);
		const zeroBefore = treeHash(zero);
		const none = capabilitiesOf(zero);
		expect(treeHash(zero)).toBe(zeroBefore);
		expect(none.source.condition).toMatchObject({ state: "degraded", sealedAt: 1 });
		expect(validateEndoCockpitCapabilityStateV0(none)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(withSeal(none, 2))).toBeNull();
	});

	it("an absent registry and an opened empty one each carry their own fixed digest", () => {
		const absent = capabilitiesOf(tempRoot());
		expect(absent.source.condition.state).toBe("absent");
		expect(validateEndoCockpitCapabilityStateV0(absent)).not.toBeNull();

		const root = tempRoot();
		mkdirSync(dirname(registryLog(root)), { recursive: true });
		writeFileSync(registryLog(root), Buffer.from([0, 0, 1, 0, 7])); // a torn tail only: opened, no record
		const empty = capabilitiesOf(root);
		expect(empty.source.condition).toMatchObject({ state: "degraded" });
		expect(empty.source.watermark!.counts).toEqual({
			fingerprint: 0,
			change: 0,
			evidence: 0,
			state: 0,
			notification: 0,
		});
		expect(validateEndoCockpitCapabilityStateV0(empty)).not.toBeNull();
		expect(empty.source.watermark!.contentDigest).not.toBe(absent.source.watermark!.contentDigest);

		// A zero-byte log is an opened, empty registry: the same content, so the same digest.
		const blank = tempRoot();
		mkdirSync(dirname(registryLog(blank)), { recursive: true });
		writeFileSync(registryLog(blank), Buffer.alloc(0));
		const blankBefore = treeHash(blank);
		const opened = capabilitiesOf(blank);
		expect(treeHash(blank)).toBe(blankBefore);
		expect(opened.source.condition.state).toBe("empty");
		expect(validateEndoCockpitCapabilityStateV0(opened)).not.toBeNull();
		expect(opened.source.watermark!.contentDigest).toBe(empty.source.watermark!.contentDigest);

		// Neither digest stands in for the other, nor does any fabricated one.
		const swap = (value: any, digest: string) => {
			const copy = structuredClone(value);
			copy.source.watermark.contentDigest = digest;
			return copy;
		};
		expect(validateEndoCockpitCapabilityStateV0(swap(absent, empty.source.watermark!.contentDigest))).toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(swap(empty, absent.source.watermark!.contentDigest))).toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(swap(empty, "0".repeat(64)))).toBeNull();
		// The digest of a non-empty registry is still not decided by the wire.
		expect(validateEndoCockpitCapabilityStateV0(swap(capabilitiesOf(seeded().root), "0".repeat(64)))).not.toBeNull();
	});
});

describe("public commitments under an explicit digest key (eighth review round, P1)", () => {
	const KEY_BYTES = Buffer.alloc(32, 0x5a);
	const hmac = (value: unknown) => createHmac("sha256", KEY_BYTES).update(canonicalEndoJsonV0(value)).digest("hex");
	// The consumer knows every field of the event but the hidden one, so it can build each candidate exactly.
	const guessable = (secret: string) =>
		event("tool.started", { toolName: "bash", args: { command: secret } }, { id: "endo.event.guess.1", sequence: 1 });
	const secretLog = (secret: string) => {
		const root = tempRoot();
		const hidden = guessable(secret);
		ingestAll(root, [hidden]);
		return { root, hidden };
	};

	it("a hidden low-entropy value cannot be confirmed from the published prefix digest, but still binds it", () => {
		const { root } = secretLog("7341");
		const read = readEndoCockpitEventLogV0(root);
		const published = read.source.watermark!.prefixDigest!;
		// The consumer knows the whole projected envelope and enumerates every four-digit candidate for the hidden value,
		// with the construction the earlier contract used: a plain sha256 over the line of the event's plain sha256.
		const plainPrefix = (secret: string) => sha256HexV0(`${sha256HexV0(canonicalEndoJsonV0(guessable(secret)))}\n`);
		const candidates = Array.from({ length: 10000 }, (_, n) => String(n).padStart(4, "0"));
		expect(candidates.filter((c) => plainPrefix(c) === published)).toEqual([]);
		// The key holder, and only they, can recompute it.
		const chain = (secret: string) => plainPrefix(secret);
		expect(
			hmac({
				purpose: "endo.cockpit.event-prefix.v0",
				length: 1,
				chain: chain("7341"),
			}),
		).toBe(published);
		expect(hmac({ purpose: "endo.cockpit.event-prefix.v0", length: 1, chain: chain("7342") })).not.toBe(published);
		// The tokens of the timeline JSON never contain the plain chain.
		expect(JSON.stringify(readEndoCockpitTimelineV0(root))).not.toContain(chain("7341"));
	});

	it("a registry's hidden record text is committed to only under the key", () => {
		const root = tempRoot();
		seedRegistry(root);
		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		registry.append("change", changeRecord());
		registry.append("notification", notificationRecord({ lines: ["Detected: pin 4417"] }));
		const { source, records } = readEndoCockpitRegistryV0(root, ATTACHMENT);
		const content = Object.fromEntries(
			["fingerprint", "change", "evidence", "state", "notification"].map((kind) => [kind, (records as any)[kind]]),
		);
		const plain = sha256HexV0(canonicalEndoJsonV0(content));
		expect(source.watermark!.contentDigest).not.toBe(plain);
		expect(source.watermark!.contentDigest).toBe(hmac({ purpose: "endo.cockpit.registry-content.v0", content }));
		// Guessing the hidden line against the plain construction finds nothing.
		for (let n = 4400; n < 4430; n += 1) {
			const guess = structuredClone(content) as any;
			guess.notification[0].lines = [`Detected: pin ${n}`];
			expect(sha256HexV0(canonicalEndoJsonV0(guess))).not.toBe(source.watermark!.contentDigest);
		}
		// The stored identity digest covers the real path; it is presented only as a keyed token.
		const stored = (records as any).fingerprint[0].identity.digest as string;
		const snapshot = JSON.stringify(readEndoCockpitSnapshotV0(root));
		expect(snapshot).not.toContain(stored);
		const identity = readEndoCockpitRuntimeV0(root, ATTACHMENT).identity;
		expect(identity.current!.identity).toMatchObject({
			value: { digest: hmac({ purpose: "endo.cockpit.identity-digest.v0", digest: stored }) },
		});
		// An unchanged registry is unchanged; a changed record under the same ids is changed.
		expect(checkEndoCockpitSourceFreshnessV0(root, source)).toBe("unchanged");
		registry.append("notification", notificationRecord({ id: "endo.evidence.test-notification.2" }));
		expect(checkEndoCockpitSourceFreshnessV0(root, source)).toBe("changed");
	});

	it("aliases of withheld identifiers are keyed: a guessed identifier does not confirm", () => {
		const root = tempRoot();
		ingestAll(root, [event("tool.started", {}, { id: "endo.event.Tok_one" })]);
		const entry = readEndoCockpitTimelineV0(root).entries[0]!;
		const plainAlias = `endo.event.withheld-${sha256HexV0("endo.event.Tok_one").slice(0, 32)}`;
		expect(entry.eventId).not.toBe(plainAlias);
		expect(entry.eventId).toBe(
			`endo.event.withheld-${hmac({ purpose: "endo.cockpit.id-alias.v0", id: "endo.event.Tok_one" }).slice(0, 32)}`,
		);
		// The watermark's last id is the same alias as the entry's.
		expect(readEndoCockpitTimelineV0(root).source.watermark!.lastEventId).toBe(entry.eventId);
	});

	it("is deterministic within one context and differs across contexts", () => {
		const { root } = seeded();
		const a = canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root, { limit: 1000 }));
		expect(canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root, { limit: 1000 }))).toBe(a);
		const other = readSnapshotRaw(root, { digestKey: OTHER_KEY, limit: 1000 });
		expect(validateEndoCockpitSnapshotV0(other)).not.toBeNull();
		expect(other.timeline.source.watermark!.keyId).toBe(OTHER_KEY.keyId);
		expect(other.timeline.source.watermark!.prefixDigest).not.toBe(
			readEndoCockpitTimelineV0(root).source.watermark!.prefixDigest,
		);
		expect(canonicalEndoJsonV0(other)).not.toBe(a);
		// A snapshot never mixes key contexts.
		const mixed = structuredClone(readEndoCockpitSnapshotV0(root));
		mixed.runtimes[0]!.identity.source.watermark!.keyId = OTHER_KEY.keyId;
		mixed.runtimes[0]!.capabilities.source.watermark!.keyId = OTHER_KEY.keyId;
		expect(validateEndoCockpitSnapshotV0(mixed)).toBeNull();
	});

	it("freshness under another or no key says so, and never unchanged, shrunk or diverged", () => {
		const { root, events } = seeded();
		const log = readEndoCockpitEventLogV0(root, { limit: 1000 }).source;
		const registry = readEndoCockpitRegistryV0(root, ATTACHMENT).source;
		const before = treeHash(root);
		expect(checkEndoCockpitSourceFreshnessV0(root, log)).toBe("unchanged");
		expect(checkEndoCockpitSourceFreshnessV0(root, registry)).toBe("unchanged");
		expect(checkEndoCockpitSourceFreshnessV0(root, log, OTHER_KEY)).toBe("digest-context-differs");
		expect(checkEndoCockpitSourceFreshnessV0(root, registry, OTHER_KEY)).toBe("digest-context-differs");
		expect(checkRaw(root, log, undefined as never)).toBe("digest-context-differs");
		expect(checkRaw(root, registry, null as never)).toBe("digest-context-differs");
		expect(treeHash(root)).toBe(before);
		// A same-id content rewrite is still diverged under the right key, and the log can still be continued from.
		const rewritten = tempRoot();
		ingestAll(rewritten, [
			{ ...events[0]!, payload: { ...(events[0]!.payload as object), replaced: true } },
			...events.slice(1),
		]);
		expect(checkEndoCockpitSourceFreshnessV0(rewritten, log)).toBe("diverged");
		const grown = tempRoot();
		ingestAll(grown, [...events, event("tool.started", {}, { id: "endo.event.more.1" })]);
		expect(checkEndoCockpitSourceFreshnessV0(grown, log)).toBe("advanced");
	});

	it("a registry record rewritten under the same ids and counts is still detected", () => {
		const build = (line: string) => {
			const root = tempRoot();
			seedRegistry(root);
			const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
			registry.append("change", changeRecord());
			registry.append("notification", notificationRecord({ lines: [line] }));
			return root;
		};
		const a = build("Detected: pin 4417");
		const b = build("Detected: pin 4418");
		const held = readEndoCockpitRegistryV0(a, ATTACHMENT).source;
		const other = readEndoCockpitRegistryV0(b, ATTACHMENT).source;
		expect(other.watermark!.counts).toEqual(held.watermark!.counts);
		expect(other.watermark!.lastIds).toEqual(held.watermark!.lastIds);
		expect(other.watermark!.contentDigest).not.toBe(held.watermark!.contentDigest);
		expect(checkEndoCockpitSourceFreshnessV0(b, held)).toBe("changed");
		expect(checkEndoCockpitSourceFreshnessV0(a, held)).toBe("unchanged");
	});

	it("is byte-identical across reads under one private key, and different under another", () => {
		const { root } = seeded();
		const read = (key: typeof OTHER_KEY) =>
			canonicalEndoJsonV0(readSnapshotRaw(root, { digestKey: key, limit: 1000 }));
		expect(OTHER_KEY.public).toBe(false);
		expect(read(OTHER_KEY)).toBe(read(OTHER_KEY));
		expect(read(OTHER_KEY)).not.toBe(read(TEST_KEY));
		// Neither key's raw bytes appear in any output.
		for (const [key, bytes] of [
			[OTHER_KEY, Buffer.alloc(32, 0x11)],
			[TEST_KEY, Buffer.alloc(32, 0x5a)],
		] as const) {
			const text = read(key);
			expect(text).not.toContain(bytes.toString("hex"));
			expect(text).not.toContain(bytes.toString("base64"));
		}
	});

	it("no stored digest whose preimage includes withheld data is published unkeyed", () => {
		const root = tempRoot();
		seedRegistry(root);
		const { fingerprint, evidence, state } = specimen();
		const stored = new Set<string>([fingerprint.identity.digest]);
		for (const item of evidence) {
			stored.add(item.dependencies.identityDigest);
			stored.add(item.dependencies.configurationDigest);
			for (const support of item.evidence) if (/^[0-9a-f]{64}$/.test(support)) stored.add(support);
		}
		void state;
		expect(stored.size).toBeGreaterThan(2);
		const text = JSON.stringify(readEndoCockpitSnapshotV0(root));
		for (const digest of stored) expect(text, digest).not.toContain(digest);
		// What is kept on purpose: the entrypoint file's own sha256 (a public artifact whose size is shown beside it).
		expect(text).toContain(fingerprint.local.entrypoint!.sha256);
	});

	it("a read without a usable key is a usage error before any disk access, and creates nothing", () => {
		const root = join(tempRoot(), "nowhere");
		const home = homedir();
		const homeBefore = existsSync(home) ? readdirSync(home).sort().join("|") : "";
		for (const bad of [undefined, null, {}, { keyId: "x", digest: 1 }, { keyId: "Bad Id", digest: () => ({}) }])
			expect(() => readLogRaw(root, { digestKey: bad as never }), String(bad)).toThrow(TypeError);
		expect(() => readLogRaw(root, undefined as never)).toThrow(TypeError);
		expect(() => readRegistryRaw(root, ATTACHMENT, undefined as never)).toThrow(TypeError);
		expect(() => readSnapshotRaw(root, {} as never)).toThrow(TypeError);
		expect(existsSync(root)).toBe(false);
		expect(existsSync(home) ? readdirSync(home).sort().join("|") : "").toBe(homeBefore);
	});

	it("a projection under a key the source was not read under is refused", () => {
		const { root } = seeded();
		const read = readLogRaw(root, { digestKey: TEST_KEY, limit: 5 });
		expect(() => projectRaw({ source: read.source, afterSequence: 0, events: read.events }, OTHER_KEY)).toThrow(
			TypeError,
		);
		expect(() => projectRaw({ source: read.source, afterSequence: 0, events: read.events }, TEST_KEY)).not.toThrow();
	});

	it("key material is never serialized, and no loader or fixed key is reachable from the library", () => {
		const { root } = seeded();
		const text = JSON.stringify([readEndoCockpitSnapshotV0(root), readEndoCockpitEventLogV0(root).source]);
		expect(text).not.toContain(KEY_BYTES.toString("hex"));
		expect(text).not.toContain(KEY_BYTES.toString("base64"));
		for (const dir of ["cockpit", "cockpit/projections"]) {
			for (const name of readdirSync(join(import.meta.dirname, "..", dir)).filter((f) => f.endsWith(".ts"))) {
				const source = readFileSync(join(import.meta.dirname, "..", dir, name), "utf8");
				expect(source, `${dir}/${name}`).not.toMatch(
					/loadOrCreateEndoDigestKeyV0|endoDigestKeyFromEnvironmentV0|storage\/digest-key|process\.env|Date\.now|Math\.random/,
				);
			}
		}
	});
});
