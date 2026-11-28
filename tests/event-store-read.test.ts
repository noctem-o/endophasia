import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { endoSessionLogV0 } from "../cli/develop-service.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import {
	endoRouteAttemptEvidenceV0,
	endoSessionLogOfStreamV0,
	endoSessionStreamsV0,
	pageEndoEventStreamV0,
	readEndoAttachmentResumeV0,
	readEndoEventStoreV0,
} from "../storage/event-store-read.ts";
import { endoEventStreamPathV0 } from "../storage/event-stream-path.ts";
import { endoFrameBytesV0 } from "../storage/log.ts";
import { endoStoreFormatPathsV0 } from "../storage/store-format.ts";
import {
	attachEndoEventStoreWriterV0,
	initEndoEventStoreV0,
	migrateEndoEventStoreV0,
} from "../storage/store-format-write.ts";
import { concurrentEvent } from "./helpers/concurrent-event-fixture.ts";

const roots: string[] = [];
const stream = (attachmentId: string) => ({ kind: "attachment", attachmentId }) as const;
const frame = (event: EndoEventV0) => endoFrameBytesV0(Buffer.from(canonicalEndoJsonV0(event)));
const legacy = { kind: "legacy" } as const;
const at = () => Date.parse("2026-11-28T02:00:00Z");
const logOf = (root: string, attachment: string) => endoEventStreamPathV0(root, stream(attachment));

function scratch() {
	const path = mkdtempSync(join(tmpdir(), "endo-event-read-"));
	roots.push(path);
	return path;
}
function add(root: string, attachment: string, ...events: EndoEventV0[]) {
	const writer = attachEndoEventStoreWriterV0(root, attachment);
	try {
		for (const event of events) writer.store.ingest(event);
	} finally {
		writer.close();
	}
}
function addLegacy(root: string, ...events: EndoEventV0[]) {
	const store = createEndoDurableEventStoreV0(root);
	try {
		for (const event of events) store.ingest(event);
	} finally {
		store.close();
	}
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["absent", "empty", "clean", "torn", "sealed", "invalid", "duplicate", "over-budget"])(
	"matches the legacy-only projection byte for byte for a %s log",
	(kind) => {
		const root = scratch();
		const path = endoEventStreamPathV0(root, legacy);
		const one = concurrentEvent("pi.one");
		const two = frame(concurrentEvent("pi.two"));
		if (kind === "sealed") two[two.length - 1] ^= 1;
		if (kind !== "absent") {
			mkdirSync(join(root, "events"));
			const suffix =
				kind === "torn"
					? two.subarray(0, 21)
					: kind === "sealed"
						? two
						: kind === "invalid"
							? endoFrameBytesV0(Buffer.from("{"))
							: kind === "duplicate"
								? frame(one)
								: Buffer.alloc(0);
			writeFileSync(path, kind === "empty" ? Buffer.alloc(0) : Buffer.concat([frame(one), suffix]));
		}
		const expected =
			kind === "absent" || kind === "invalid" || kind === "duplicate" || kind === "over-budget"
				? { state: "unavailable" }
				: {
						state: kind === "torn" || kind === "sealed" ? "partial" : "complete",
						events: kind === "empty" ? [] : [one],
					};
		const maxBytes = kind === "over-budget" ? 1 : undefined;
		const first = existsSync(path) ? readFileSync(path) : null;
		const model = readEndoEventStoreV0(root, { only: [legacy], maxBytes, now: at });
		expect(canonicalEndoJsonV0(endoSessionLogOfStreamV0(model.streams[0]))).toBe(canonicalEndoJsonV0(expected));
		if (first !== null && kind !== "invalid" && kind !== "duplicate" && kind !== "over-budget") {
			const old = createEndoDurableEventStoreV0(root, { readOnly: true });
			expect(endoSessionLogOfStreamV0(model.streams[0])).toEqual({
				state: old.recovery().sealed || old.recovery().truncated ? "partial" : "complete",
				events: old.page().events,
			});
			old.close();
		}
		if (kind !== "over-budget")
			expect(canonicalEndoJsonV0(endoSessionLogV0(root))).toBe(canonicalEndoJsonV0(expected));
		expect(existsSync(path) ? readFileSync(path) : null).toEqual(first);
	},
);

it("retains unrelated stream standing after checksum damage and recovers the next read after a partial tail", () => {
	const root = scratch();
	initEndoEventStoreV0(root);
	const first = concurrentEvent("pi.one");
	const next = concurrentEvent("pi.one", 2);
	const healthy = concurrentEvent("pi.two");
	add(root, "pi.one", first, next);
	add(root, "pi.two", healthy);
	const bad = logOf(root, "pi.one");
	const bytes = readFileSync(bad);
	bytes[bytes.length - 1] ^= 1;
	writeFileSync(bad, bytes);
	const before = readEndoEventStoreV0(root, { now: at });
	expect(before.aggregate).toBe("sealed");
	expect(before.streams.map((item) => [item.standing.key, item.standing.completeness, item.events])).toEqual([
		["attachment:pi.one", "sealed", [first]],
		["attachment:pi.two", "complete", [healthy]],
	]);
	const two = concurrentEvent("pi.two", 2);
	appendFileSync(logOf(root, "pi.two"), frame(two).subarray(0, 9));
	const partial = readEndoEventStoreV0(root, { only: [stream("pi.two")], maxBytes: 1000 });
	expect(partial.streams[0]?.standing.completeness).toBe("torn-tail");
	add(root, "pi.two", two);
	const after = readEndoEventStoreV0(root, { only: [stream("pi.two")], maxBytes: 1000 });
	expect(after.streams[0]).toMatchObject({ events: [healthy, two], standing: { completeness: "complete" } });
	expect(readFileSync(bad)).toEqual(bytes);
});

it("shares a finite byte budget across streams and refuses to infer absence after bounded discovery", () => {
	const root = scratch();
	initEndoEventStoreV0(root);
	for (const attachment of ["pi.one", "pi.two", "pi.three"]) add(root, attachment, concurrentEvent(attachment));
	const maxBytes = frame(concurrentEvent("pi.one")).length;
	const read = readEndoEventStoreV0(root, { maxBytes, maxAttachments: 2, priority: ["attachment:pi.one"] });
	expect(read.attachmentsTruncated).toBe(true);
	expect(read.discoveryComplete).toBe(false);
	expect(read.aggregate).toBe("budget-exhausted");
	expect(read.budget.consumedBytes).toBeLessThanOrEqual(maxBytes);
	expect(read.findings).toContainEqual({ code: "attachments-truncated" });
	expect(endoSessionStreamsV0(read, "endo.session.never").inLog).toBe("unknown");
	const only = readEndoEventStoreV0(root, { maxBytes, priority: ["attachment:pi.one"] });
	expect(only.budget.consumedBytes).toBe(maxBytes);
	expect(only.streams.map(({ standing }) => standing.completeness)).toEqual([
		"complete",
		"budget-exhausted",
		"budget-exhausted",
	]);
});

it("rejects an unavailable stream safely without hiding later streams, and sees the stream on the next bounded read", () => {
	const root = scratch();
	initEndoEventStoreV0(root);
	const path = logOf(root, "pi.one");
	mkdirSync(join(path, ".."));
	symlinkSync("/dev/null", path);
	add(root, "pi.two", concurrentEvent("pi.two"));
	const blocked = readEndoEventStoreV0(root, { maxBytes: 1000 });
	expect(blocked.streams.map(({ standing }) => standing.completeness)).toEqual(["unopenable", "complete"]);
	rmSync(path);
	add(root, "pi.one", concurrentEvent("pi.one"));
	expect(readEndoEventStoreV0(root, { maxBytes: 1000 }).aggregate).toBe("complete");
});

it("retains identical and conflicting duplicate events, and refuses a derivation from a sibling", () => {
	const root = scratch();
	initEndoEventStoreV0(root);
	const one = { ...concurrentEvent("pi.one"), producer: "fixture" };
	const two = concurrentEvent("pi.two", 2);
	add(root, "pi.one", one);
	add(root, "pi.two", one, two);
	add(root, "pi.three", { ...two, producer: "pi-rpc-adapter:pi.three", payload: { changed: true } });
	const child = { ...concurrentEvent("pi.four"), derivedFrom: [two.id] };
	add(root, "pi.four", child);
	const read = readEndoEventStoreV0(root, { priority: ["attachment:pi.three"] });
	expect(read.findings).toEqual(
		expect.arrayContaining([
			{
				code: "duplicate-event-id-across-streams",
				stream: "attachment:pi.two",
				other: "attachment:pi.one",
				eventId: one.id,
				conflict: false,
			},
			{
				code: "duplicate-event-id-across-streams",
				stream: "attachment:pi.two",
				other: "attachment:pi.three",
				eventId: two.id,
				conflict: true,
			},
			{
				code: "cross-stream-derivation",
				stream: "attachment:pi.four",
				parentStream: "attachment:pi.two",
				eventId: child.id,
				parentId: two.id,
			},
		]),
	);
	expect(read.streams.flatMap(({ events }) => events.map(({ id }) => id)).filter((id) => id === one.id)).toHaveLength(
		2,
	);
	expect(read.streams.find(({ standing }) => standing.key === "attachment:pi.four")).toMatchObject({
		events: [child],
		evidenceLength: 0,
		standing: { completeness: "incomplete-uncertain" },
	});
	expect(read.streams.find(({ standing }) => standing.key === "attachment:pi.one")?.standing.completeness).toBe(
		"complete",
	);
});

it("keeps the legacy section and the attachment called legacy distinct, including their cursors", () => {
	const root = scratch();
	const store = createEndoDurableEventStoreV0(root);
	store.ingest(concurrentEvent("legacy"));
	store.close();
	migrateEndoEventStoreV0(root, true);
	const own = concurrentEvent("legacy", 2);
	add(root, "legacy", own);
	const read = readEndoEventStoreV0(root, { now: at });
	const [a, b] = read.streams;
	expect(a?.standing.key).toBe("legacy");
	expect(b?.standing.key).toBe("attachment:legacy");
	const page = pageEndoEventStreamV0(b!);
	expect(page.events).toEqual([own]);
	expect(() => pageEndoEventStreamV0(a!, page.next)).toThrow(/does not match/);
	const following = concurrentEvent("legacy", 3);
	add(root, "legacy", following);
	const resumed = readEndoEventStoreV0(root, { only: [stream("legacy")] }).streams[0]!;
	expect(pageEndoEventStreamV0(resumed, page.next).events).toEqual([following]);
	writeFileSync(logOf(root, "legacy"), frame({ ...own, payload: { changed: true } }));
	expect(() => pageEndoEventStreamV0(readEndoEventStoreV0(root).streams[1]!, page.next)).toThrow(/does not match/);
	expect(endoRouteAttemptEvidenceV0(read, "legacy")).toMatchObject({ ok: true, streams: [a, b] });
	expect(endoSessionLogV0(root)).toEqual({ state: "unavailable" });
});

it("seeds an attachment from legacy and its own stream without re-observing deterministic entries", () => {
	const root = scratch();
	const first = concurrentEvent("pi.one");
	const other = concurrentEvent("pi.two");
	addLegacy(root, first, other);
	migrateEndoEventStoreV0(root, true);
	const second = concurrentEvent("pi.one", 2);
	add(root, "pi.one", second);
	const writer = attachEndoEventStoreWriterV0(root, "pi.one");
	try {
		const resume = readEndoAttachmentResumeV0(root, writer, (event) => event.producer === first.producer);
		expect(resume.legacy).toEqual([first]);
		expect(resume.own).toEqual([second]);
		const seen = new Set([...resume.legacySeenIds, ...resume.own.map(({ id }) => id)]);
		const cursor = Math.max(...[...resume.legacy, ...resume.own].map(({ sequence }) => sequence));
		expect(cursor).toBe(2);
		for (const replay of [first, second, concurrentEvent("pi.one", cursor + 1)]) {
			if (!seen.has(replay.id)) writer.store.ingest(replay);
		}
		expect(writer.store.page().events).toEqual([second, concurrentEvent("pi.one", 3)]);
	} finally {
		writer.close();
	}
	expect(readEndoEventStoreV0(root).findings).toEqual([]);
});

it("isolates drift and quarantines post-seal duplicates to legacy without spending an attachment-only budget on it", () => {
	const root = scratch();
	const legacyEvent = concurrentEvent("pi.one");
	addLegacy(root, legacyEvent);
	migrateEndoEventStoreV0(root, true);
	const own = concurrentEvent("pi.two");
	add(root, "pi.two", own);
	appendFileSync(endoStoreFormatPathsV0(root).legacy, frame({ ...own, payload: { changedAfterSeal: true } }));
	const all = readEndoEventStoreV0(root, { now: at });
	expect(all.format).toBe("legacy-seal-drift");
	expect(all.streams[0]).toMatchObject({ evidenceLength: 1, standing: { completeness: "incomplete-uncertain" } });
	expect(all.streams[1]).toMatchObject({ evidenceLength: 1, standing: { completeness: "complete" } });
	expect(all.findings).toContainEqual({
		code: "duplicate-event-id-across-streams",
		stream: "legacy",
		other: "attachment:pi.two",
		eventId: own.id,
		conflict: true,
	});
	const only = readEndoEventStoreV0(root, { only: [stream("pi.two")], maxBytes: frame(own).length });
	expect(only.findings).toEqual([]);
	expect(only.legacySealVerified).toBeNull();
	expect(only.aggregate).toBe("complete");
	rmSync(endoStoreFormatPathsV0(root).lock);
	const broken = readEndoEventStoreV0(root, { only: [stream("pi.two")] });
	expect(broken.barrierFinding).toMatchObject({ kind: "sentinel-lost" });
	expect(broken.streams[0]).toMatchObject({
		events: [own],
		evidenceLength: 0,
		standing: { completeness: "incomplete-uncertain" },
	});
});
