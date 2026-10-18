// PR #57 review round 20, finding 1: a complete event-log input is checked against the prefix digest its source advertises.
// Findings 2 and 3 (duplicate-owner elimination, runtime-disagreement reconciliation) have their own sections below.

import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	ENDO_COCKPIT_PAGE_MAX_LIMIT_V0,
	type EndoCockpitEventLogSourceV0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { endoFrameBytesV0 } from "../storage/log.ts";
import {
	ATTACHMENT,
	changeRecord,
	completeLogSource,
	event,
	ingestAll,
	lifecycleEvents,
	modelPrefixDigest,
	notificationRecord,
	removeTempRoots,
	specimenRecords,
	stored,
	tempRoot,
} from "./cockpit-fixtures.ts";
import {
	projectEndoCockpitSessionTimelineV0,
	readEndoCockpitEventLogV0,
	readEndoCockpitSnapshotV0,
	TEST_KEY,
} from "./cockpit-keyed.ts";
import {
	admittedAt,
	aliasOf,
	capabilitiesOf,
	codes,
	evidenceMatching,
	fingerprintAt,
	foreign,
	identityOf,
	rank,
	snapshotFrom,
	snapshotOf,
} from "./cockpit-registry-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const FIXTURE = "killed-and-resumed";
const mutated = <T>(value: T, edit: (copy: any) => void): T => {
	const copy = structuredClone(value);
	edit(copy);
	return copy;
};

// ---------------------------------------------------------------------------------------------------------------
// 1. A complete event-log input must match its advertised prefix digest
// ---------------------------------------------------------------------------------------------------------------

describe("a complete event-log input is checked against its prefix digest (P2)", () => {
	const seeded = (events = lifecycleEvents(FIXTURE)) => {
		const root = tempRoot();
		ingestAll(root, events);
		return { root, events };
	};
	const wholeRead = (root: string) => readEndoCockpitEventLogV0(root, { limit: ENDO_COCKPIT_PAGE_MAX_LIMIT_V0 });
	const projectRead = (read: ReturnType<typeof wholeRead>, edit: (input: any) => void = () => {}) => {
		const input = { source: read.source, afterSequence: read.afterSequence, events: read.events } as any;
		edit(input);
		return projectEndoCockpitSessionTimelineV0(input, TEST_KEY);
	};
	const setDigest = (digest: string | null) => (input: any) => {
		input.source = mutated(input.source, (s) => {
			s.watermark.prefixDigest = digest;
		});
	};
	const MESSAGE = /prefix digest/;

	it("projects the whole log a reader read, and the digest is the reader's", () => {
		const { root, events } = seeded();
		const read = wholeRead(root);
		expect(read.source.watermark!.length).toBe(events.length);
		expect(read.source.watermark!.prefixDigest).toBe(modelPrefixDigest(events, TEST_KEY));
		const timeline = projectRead(read);
		expect(timeline.entries).toHaveLength(events.length);
		expect(timeline.window.hasMore).toBe(false);
	});

	it("Codex's mutation: any other well-shaped digest is refused", () => {
		const { root } = seeded();
		const read = wholeRead(root);
		for (const digest of ["f".repeat(64), "0".repeat(64), sha256HexV0("another")])
			expect(() => projectRead(read, setDigest(digest))).toThrow(MESSAGE);
	});

	it("an event whose payload changed under an unchanged id is refused", () => {
		const { root } = seeded();
		const read = wholeRead(root);
		expect(() =>
			projectRead(read, (input) => {
				input.events = mutated(input.events, (events) => {
					events[1].event.payload = { ...events[1].event.payload, altered: true };
				});
			}),
		).toThrow(MESSAGE);
	});

	it("events presented in another order are refused, though the last event and its id are unchanged", () => {
		const { root } = seeded();
		const read = wholeRead(root);
		expect(read.events.length).toBeGreaterThan(2);
		expect(() =>
			projectRead(read, (input) => {
				const [a, b] = [input.events[0].event, input.events[1].event];
				input.events = mutated(input.events, (events) => {
					events[0].event = b;
					events[1].event = a;
				});
			}),
		).toThrow(MESSAGE);
	});

	it("a time or producer detail the timeline never shows is still committed to", () => {
		const { root } = seeded();
		const read = wholeRead(root);
		expect(() =>
			projectRead(read, (input) => {
				input.events = mutated(input.events, (events) => {
					events[0].event.at = "2030-01-01T00:00:00Z";
				});
			}),
		).toThrow(MESSAGE);
	});

	it("a digest minted under other key material with the same key id is refused: the token is checked, not only the id", () => {
		const impostor = endoDigestKeyV0(Buffer.alloc(32, 0x77), "cockpit-fixture", { public: true });
		expect(impostor.keyId).toBe(TEST_KEY.keyId);
		const { root, events } = seeded();
		const read = wholeRead(root);
		const forged = modelPrefixDigest(events, impostor)!;
		expect(forged).not.toBe(modelPrefixDigest(events, TEST_KEY));
		expect(() => projectRead(read, setDigest(forged))).toThrow(MESSAGE);
	});

	it("a token over the right chain but another length, or over a shorter chain, is refused", () => {
		const { root, events } = seeded();
		const read = wholeRead(root);
		const chain = (list: readonly unknown[]) =>
			sha256HexV0(list.map((item) => `${sha256HexV0(canonicalEndoJsonV0(item))}\n`).join(""));
		const token = (length: number, over: readonly unknown[]) =>
			TEST_KEY.digest({ purpose: "endo.cockpit.event-prefix.v0", length, chain: chain(over) }).value;
		expect(token(events.length, events)).toBe(read.source.watermark!.prefixDigest);
		expect(() => projectRead(read, setDigest(token(events.length + 1, events)))).toThrow(MESSAGE);
		expect(() => projectRead(read, setDigest(token(events.length, events.slice(0, -1))))).toThrow(MESSAGE);
		// The token binds its purpose: the same chain under another purpose is no commitment of the event log.
		const otherPurpose = TEST_KEY.digest({
			purpose: "endo.cockpit.registry-content.v0",
			length: events.length,
			chain: chain(events),
		}).value;
		expect(() => projectRead(read, setDigest(otherPurpose))).toThrow(MESSAGE);
	});

	it("frames every event of the window, a repeated id included, exactly as the reader frames what the store returns", () => {
		const first = event("agent.prompt-accepted");
		const second = event("tool.started", { n: 1 }, { id: "endo.event.test.twice" });
		const again = event("tool.started", { n: 2 }, { id: "endo.event.test.twice" });
		const log = [first, second, again];
		const source = completeLogSource(log, TEST_KEY);
		const run = (digest: string | null) =>
			projectEndoCockpitSessionTimelineV0(
				{
					source: mutated(source, (s) => {
						s.watermark.prefixDigest = digest;
					}),
					afterSequence: 0,
					events: stored(log),
				} as never,
				TEST_KEY,
			);
		const accepted = run(source.watermark!.prefixDigest);
		expect(accepted.duplicatesIgnored).toBe(1);
		// A digest over only the events the projection keeps (the repeat is ignored) is not the reader's.
		const keptOnly = TEST_KEY.digest({
			purpose: "endo.cockpit.event-prefix.v0",
			length: log.length,
			chain: sha256HexV0([first, second].map((item) => `${sha256HexV0(canonicalEndoJsonV0(item))}\n`).join("")),
		}).value;
		expect(() => run(keptOnly)).toThrow(MESSAGE);
		// The repeat's own content counts: altering only it breaks the commitment.
		expect(() =>
			projectEndoCockpitSessionTimelineV0(
				{
					source,
					afterSequence: 0,
					events: stored([first, second, { ...again, payload: { n: 3 } }]),
				} as never,
				TEST_KEY,
			),
		).toThrow(MESSAGE);
	});

	it("an empty history keeps its null digest; a degraded log whole prefix is verified; a torn tail adds nothing", () => {
		const empty = tempRoot();
		const none = wholeRead(empty);
		expect(none.source.watermark).toEqual({
			length: 0,
			lastEventId: null,
			prefixDigest: null,
			keyId: TEST_KEY.keyId,
		});
		expect(projectRead(none).entries).toEqual([]);
		// A digest on a log with no events is refused by the source contract, as before.
		expect(() => projectRead(none, setDigest("a".repeat(64)))).toThrow();

		const { root, events } = seeded();
		const tail = endoFrameBytesV0(new TextEncoder().encode(JSON.stringify(event("tool.started")))).subarray(0, 21);
		appendFileSync(join(root, "events", "events.log"), tail);
		const read = wholeRead(root);
		expect(read.source.condition.state).toBe("degraded");
		expect(read.source.watermark!.length).toBe(events.length);
		expect(projectRead(read).entries).toHaveLength(events.length);
		expect(() => projectRead(read, setDigest("e".repeat(64)))).toThrow(MESSAGE);
	});

	it("a partial window cannot be checked and stays acceptable, whatever digest its source advertises", () => {
		const { root, events } = seeded();
		const arbitrary = "d".repeat(64);
		// Later window: the earlier events are not supplied.
		const later = readEndoCockpitEventLogV0(root, { afterSequence: 2, limit: 3 });
		expect(later.events.length).toBeGreaterThan(0);
		expect(() => projectRead(later, setDigest(arbitrary))).not.toThrow();
		// First window that stops short of the declared length.
		const firstPage = readEndoCockpitEventLogV0(root, { limit: 2 });
		expect(firstPage.events).toHaveLength(2);
		expect(firstPage.source.watermark!.length).toBe(events.length);
		const partial = projectRead(firstPage, setDigest(arbitrary));
		expect(partial.window.hasMore).toBe(true);
		// ... and the unchanged page is, of course, acceptable too.
		expect(() => projectRead(firstPage)).not.toThrow();
	});

	it("the window that completes the log is checked only when it begins at the start", () => {
		const { root } = seeded();
		const tail = readEndoCockpitEventLogV0(root, { afterSequence: 1, limit: ENDO_COCKPIT_PAGE_MAX_LIMIT_V0 });
		expect(tail.events.at(-1)!.storageSequence).toBe(tail.source.watermark!.length);
		expect(() => projectRead(tail, setDigest("c".repeat(64)))).not.toThrow();
	});

	it("is the reader's commitment for every length, byte for byte", () => {
		for (let count = 1; count <= 6; count += 1) {
			const events = lifecycleEvents(FIXTURE).slice(0, count);
			const { root } = seeded(events);
			const read = wholeRead(root);
			expect(read.source.watermark!.prefixDigest).toBe(modelPrefixDigest(events, TEST_KEY));
			expect(() => projectRead(read)).not.toThrow();
		}
	});

	it("the serialized timeline and snapshot contracts stay shape-only: they hold no raw events to recompute from", () => {
		const { root } = seeded();
		const timeline = readEndoCockpitSnapshotV0(root, { limit: ENDO_COCKPIT_PAGE_MAX_LIMIT_V0 }).timeline;
		expect(validateEndoCockpitSessionTimelineV0(timeline)).not.toBeNull();
		const other = mutated(timeline, (t) => {
			t.source.watermark.prefixDigest = "b".repeat(64);
		});
		expect(validateEndoCockpitSessionTimelineV0(other)).not.toBeNull();
	});

	it("the reader's snapshot of a whole log still projects (the digest it reports is the one it checks)", () => {
		const { root, events } = seeded();
		const snapshot = readEndoCockpitSnapshotV0(root, { limit: ENDO_COCKPIT_PAGE_MAX_LIMIT_V0 });
		expect(snapshot.timeline.entries).toHaveLength(events.length);
		const source: EndoCockpitEventLogSourceV0 = snapshot.timeline.source;
		expect(source.watermark!.prefixDigest).toBe(modelPrefixDigest(events, TEST_KEY));
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Duplicate ownership excludes positions whose known id differs
// ---------------------------------------------------------------------------------------------------------------

describe("a duplicate's possible owners exclude positions whose known id differs (P2)", () => {
	const base = specimenRecords();
	const first = base.state[0]!;
	const [fa, fb, fc] = ["/a/pi", "/b/pi", "/c/pi"].map((path) => fingerprintAt(path));
	const old = changeRecord({ id: "endo.evidence.test-change.old" });
	const fresh = changeRecord({ id: "endo.evidence.test-change.new" });
	/** The first evidence record repeats `id`: the cleaner discards it as a duplicate of the earlier record that owns `id`. */
	const repeating = (target: { id: string; identity: { digest: string } }, id: string) =>
		evidenceMatching(base, target).map((item, at) => (at === 0 ? { ...item, id } : item));
	const records = (extra: Record<string, unknown> = {}) => ({
		...base,
		fingerprint: [fb, fc],
		change: [old, fresh],
		evidence: repeating(fc!, old.id),
		state: [{ ...first, fingerprintId: fc!.id }],
		notification: [notificationRecord({ changeId: old.id })],
		...extra,
	});
	const missingNote = (x: any) => ({
		code: "notification-change-missing",
		refs: [structuredClone(x.runtimes[0].identity.lastNotification.ref)],
	});
	const forgeMissing = (s: any) =>
		mutated(s, (x) => {
			x.runtimes[0].identity.notes.push(missingNote(x));
		});
	const dropMissing = (s: any) =>
		mutated(s, (x) => {
			x.runtimes[0].identity.notes = x.runtimes[0].identity.notes.filter(
				(n: { code: string }) => n.code !== "notification-change-missing",
			);
		});
	const withNotRecorded = (view: any) => {
		for (const v of view.capabilities)
			if (v.status !== "unverified") {
				v.limits.push({ code: "state-fingerprint-not-recorded", refs: [structuredClone(v.ref)] });
				v.limits.sort((m: { code: string }, n: { code: string }) => rank(m.code) - rank(n.code));
			}
	};
	const has = (s: any, code: string) => s.runtimes[0].identity.notes.some((n: { code: string }) => n.code === code);
	const duplicates = (s: any) =>
		[...s.runtimes[0].identity.notes, ...s.runtimes[0].capabilities.notes].filter(
			(n: { code: string }) => n.code === "duplicate-record-id",
		);

	it("Codex's snapshot: the older change owns the repeated evidence id, so its notice names a change that exists", () => {
		const s = snapshotOf(records());
		expect(duplicates(s)).toHaveLength(1);
		expect(duplicates(s)[0].refs[0]).toMatchObject({ kind: "evidence", index: 0, id: aliasOf(old.id) });
		const { identity } = s.runtimes[0];
		// Every kept fingerprint is presented with an id other than the repeated one; the newer change is presented with another.
		expect([identity.current.id, identity.previousDifferent.id]).not.toContain(aliasOf(old.id));
		expect(identity.lastChange.id).toBe(aliasOf(fresh.id));
		expect(identity.lastNotification.changeId).toBe(aliasOf(old.id));
		expect(has(s, "notification-change-missing")).toBe(false);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		// Only the older change can own it, so the notice's change is recorded: a note saying it is missing contradicts that.
		expect(validateEndoCockpitSnapshotV0(forgeMissing(s))).toBeNull();
	});

	it("the identity view alone cannot place the owner, so it accepts the same note; the snapshot refuses it", () => {
		const s = snapshotOf(records());
		const forged = forgeMissing(s);
		expect(validateEndoCockpitRuntimeIdentityV0(forged.runtimes[0].identity)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(forged.runtimes[0].capabilities)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});

	it("the converse: the unpresented older fingerprint is the only possible owner, so the state's named fingerprint is recorded", () => {
		// Every change is presented with another id (the one kept change is the last), and the two newest fingerprints are
		// presented too: only fingerprint 0 can own the repeated evidence id, and the state names it.
		const s = snapshotOf(
			records({
				fingerprint: [fa!, fb!, fc!],
				change: [fresh],
				evidence: repeating(fa!, fa!.id),
				state: [{ ...first, fingerprintId: fa!.id }],
				notification: [notificationRecord({ changeId: fresh.id })],
			}),
		);
		expect(duplicates(s)).toHaveLength(1);
		expect([s.runtimes[0].identity.current.id, s.runtimes[0].identity.previousDifferent.id]).not.toContain(
			aliasOf(fa!.id),
		);
		const cap = s.runtimes[0].capabilities;
		expect(
			admittedAt(cap).every((i: number) => !codes(cap.capabilities[i]).includes("state-fingerprint-not-recorded")),
		).toBe(true);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		// The kept change cannot own it, so the older fingerprint does: a limit saying the named fingerprint is unrecorded is false.
		const forged = mutated(s, (x) => withNotRecorded(x.runtimes[0].capabilities));
		expect(validateEndoCockpitCapabilityStateV0(forged.runtimes[0].capabilities)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});

	it("keeps an unknown older candidate of each kind: the owner's kind stays undecided and either diagnostic is admissible", () => {
		// Fingerprint 0 and change 0 are both unpresented, and either could own the repeated id.
		const s = snapshotOf(records({ fingerprint: [fa!, fb!, fc!] }));
		expect(duplicates(s)).toHaveLength(1);
		expect(has(s, "notification-change-missing")).toBe(false);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forgeMissing(s))).not.toBeNull();
	});

	it("keeps a matching presented earlier record as the owner", () => {
		// The repeated id is the previous different fingerprint's: presented, so it is the owner and no change is.
		const s = snapshotOf(
			records({ evidence: repeating(fc!, fb!.id), notification: [notificationRecord({ changeId: fb!.id })] }),
		);
		expect(duplicates(s)[0].refs[0]).toMatchObject({ kind: "evidence", id: aliasOf(fb!.id) });
		expect(has(s, "notification-change-missing")).toBe(true);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(dropMissing(s))).toBeNull();
	});

	it("an earlier change set aside as foreign is no owner, and the remaining kind decides", () => {
		// The older change is foreign: only the unpresented fingerprint could own the repeated id.
		const s = snapshotOf(
			records({
				fingerprint: [fa!, fb!, fc!],
				change: [foreign(old), fresh],
				evidence: repeating(fc!, fa!.id),
				notification: [notificationRecord({ changeId: fa!.id })],
			}),
		);
		expect(duplicates(s)).toHaveLength(1);
		expect(has(s, "notification-change-missing")).toBe(true);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(dropMissing(s))).toBeNull();
	});

	it("a duplicate with no eligible earlier owner is impossible: every earlier record is presented with another id", () => {
		// The repeated id is the previous different fingerprint's; presented, kept, and the only record with it.
		const fully = records({
			change: [fresh],
			evidence: repeating(fc!, fb!.id),
			notification: [notificationRecord({ changeId: fresh.id })],
		});
		const s = snapshotOf(fully);
		expect(duplicates(s)[0].refs[0]).toMatchObject({ kind: "evidence", index: 0, id: aliasOf(fb!.id) });
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const repeated = (id: string) =>
			mutated(s, (x) => {
				x.runtimes[0].capabilities.notes.find(
					(n: { code: string }) => n.code === "duplicate-record-id",
				).refs[0].id = id;
			});
		// Another id could only have been owned by a record not presented, and none is unpresented.
		expect(validateEndoCockpitSnapshotV0(repeated(aliasOf("endo.evidence.test-change.nobody")))).toBeNull();
		// A kept change precedes every evidence record in the cleaner's order, and it is presented: it may own the id.
		expect(validateEndoCockpitSnapshotV0(repeated(aliasOf(fresh.id)))).not.toBeNull();
	});

	it("a duplicate whose every earlier record was set aside has no owner", () => {
		// Both fingerprints are foreign: nothing earlier was kept, so no repeated id of a later record can be genuine.
		const s = snapshotOf(
			records({
				fingerprint: [foreign(fb), foreign(fc)],
				change: [],
				notification: [],
				state: [{ ...first, fingerprintId: fc!.id }],
				evidence: evidenceMatching(base, fc!),
			}),
		);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const forged = mutated(s, (x) => {
			const cap = x.runtimes[0].capabilities;
			cap.notes.push({
				code: "duplicate-record-id",
				refs: [
					{
						domain: "harness-registry",
						attachment: cap.source.attachment,
						kind: "evidence",
						index: 0,
						id: aliasOf(fb!.id),
					},
				],
			});
		});
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});

	it("canonical output of the projectors validates on every shape above, view by view", () => {
		for (const shape of [
			records(),
			records({ fingerprint: [fa!, fb!, fc!] }),
			records({ change: [foreign(old), fresh], fingerprint: [fa!, fb!, fc!], evidence: repeating(fc!, fa!.id) }),
		]) {
			const identity = identityOf(shape);
			const capabilities = capabilitiesOf(shape);
			expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
			expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
			expect(validateEndoCockpitSnapshotV0(snapshotFrom(identity, capabilities))).not.toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. A runtime-disagreement note that separates the state's fingerprint from the latest one requires a runtime-differs limit
// ---------------------------------------------------------------------------------------------------------------

describe("a runtime-disagreement note reconciles with the runtime limits of the state (P2)", () => {
	const base = specimenRecords();
	const first = base.state[0]!;
	const pi = fingerprintAt("/c/pi", "pi");
	const acp = fingerprintAt("/b/pi", "acp");
	const older = fingerprintAt("/a/pi", "pi");
	/** `named` is the state's fingerprint (the older one), `latest` is the newest recorded; `state` and `evidence` runtime are chosen. */
	const records = (options: {
		list: ReturnType<typeof fingerprintAt>[];
		named: ReturnType<typeof fingerprintAt>;
		stateRuntime: string;
		evidenceRuntime?: string;
		entries?: (entry: (typeof first.capabilities)[number], at: number) => (typeof first.capabilities)[number];
	}) => ({
		...base,
		fingerprint: options.list,
		evidence: evidenceMatching(base, options.named).map((item) => ({
			...item,
			runtime: options.evidenceRuntime ?? options.stateRuntime,
		})),
		state: [
			{
				...first,
				runtime: options.stateRuntime,
				fingerprintId: options.named.id,
				capabilities: first.capabilities.map((entry, at) => options.entries?.(entry, at) ?? entry),
			},
		],
	});
	const runtimeDiffers = (view: any) => view.limits.find((l: { code: string }) => l.code === "runtime-differs");
	const admitted = (cap: any) => cap.capabilities.filter((v: { status: string }) => v.status !== "unverified");
	const dropRuntimeDiffers = (s: any) =>
		mutated(s, (x) => {
			for (const v of x.runtimes[0].capabilities.capabilities)
				v.limits = v.limits.filter((l: { code: string }) => l.code !== "runtime-differs");
		});
	const setRuntimeRefs = (s: any, pick: (view: any, s: any) => any[]) =>
		mutated(s, (x) => {
			for (const v of x.runtimes[0].capabilities.capabilities) {
				const limit = runtimeDiffers(v);
				if (limit !== undefined) limit.refs = [structuredClone(v.ref), ...pick(v, x)];
			}
		});
	const refOf = (s: any, id: string) => {
		const { identity } = s.runtimes[0];
		return [identity.current, identity.previousDifferent].find((v) => v !== null && v.id === id).ref;
	};
	const note = (s: any) =>
		s.runtimes[0].identity.notes.find((n: { code: string }) => n.code === "runtime-disagreement");

	// The state names the older (acp) fingerprint and is for the pi runtime; the latest fingerprint is pi: the named one differs.
	const namedDiffers = () => snapshotOf(records({ list: [acp, pi], named: acp, stateRuntime: "pi" }));
	// The state names the older (acp) fingerprint and is for the acp runtime; the latest fingerprint is pi: the latest differs.
	const latestDiffers = () => snapshotOf(records({ list: [acp, pi], named: acp, stateRuntime: "acp" }));

	it("Codex's snapshot: deleting runtime-differs from every admitted capability is refused", () => {
		const s = namedDiffers();
		const cap = s.runtimes[0].capabilities;
		expect(note(s).refs.map((r: { id: string }) => r.id)).toEqual([aliasOf(acp.id), aliasOf(pi.id)]);
		expect(admitted(cap).length).toBeGreaterThan(0);
		for (const v of admitted(cap)) expect(codes(v)).toContain("runtime-differs");
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const forged = dropRuntimeDiffers(s);
		// Each view alone is sound; the contradiction is between the note and the limits.
		expect(validateEndoCockpitRuntimeIdentityV0(forged.runtimes[0].identity)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(forged.runtimes[0].capabilities)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});

	it("holds in the other direction: the latest fingerprint is the one that differs", () => {
		const s = latestDiffers();
		for (const v of admitted(s.runtimes[0].capabilities)) {
			const refs = runtimeDiffers(v).refs.map((r: { kind: string; id: string }) => `${r.kind}:${r.id ?? ""}`);
			expect(refs).toEqual([`state:`, `fingerprint:${aliasOf(pi.id)}`]);
		}
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(dropRuntimeDiffers(s))).toBeNull();
	});

	it("one qualifying fingerprint reference is enough, whichever it is; the wire does not say which record differs", () => {
		for (const s of [namedDiffers(), latestDiffers()]) {
			const named = refOf(s, aliasOf(acp.id));
			const latest = refOf(s, aliasOf(pi.id));
			for (const pick of [[named], [latest], [named, latest]])
				expect(validateEndoCockpitSnapshotV0(setRuntimeRefs(s, () => structuredClone(pick)))).not.toBeNull();
		}
	});

	it("a limit citing only the evidence record does not satisfy the obligation", () => {
		for (const s of [namedDiffers(), latestDiffers()]) {
			const forged = setRuntimeRefs(s, (v) => [structuredClone(v.evidence.ref)]);
			expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
			// The evidence AND a fingerprint is a different matter: the fingerprint reference qualifies.
			const withFingerprint = setRuntimeRefs(s, (v) => [
				structuredClone(v.evidence.ref),
				structuredClone(refOf(s, aliasOf(pi.id))),
			]);
			expect(validateEndoCockpitSnapshotV0(withFingerprint)).not.toBeNull();
		}
	});

	it("only admitted capabilities carry the obligation: a mix, and a state with none admitted", () => {
		const mixed = snapshotOf(
			records({
				list: [acp, pi],
				named: acp,
				stateRuntime: "pi",
				entries: (entry, at) =>
					at % 2 === 0 ? entry : { ...entry, status: "unverified", classification: null, evidenceId: null },
			}),
		);
		const cap = mixed.runtimes[0].capabilities;
		expect(cap.capabilities.some((v: { status: string }) => v.status === "unverified")).toBe(true);
		expect(admitted(cap).length).toBeGreaterThan(0);
		expect(validateEndoCockpitSnapshotV0(mixed)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(dropRuntimeDiffers(mixed))).toBeNull();
		const none = snapshotOf(
			records({
				list: [acp, pi],
				named: acp,
				stateRuntime: "pi",
				entries: (entry) => ({ ...entry, status: "unverified", classification: null, evidenceId: null }),
			}),
		);
		expect(admitted(none.runtimes[0].capabilities)).toHaveLength(0);
		expect(note(none)).toBeDefined();
		expect(validateEndoCockpitSnapshotV0(none)).not.toBeNull();
	});

	it("is not inferred from two distinct fingerprint ids: without the note, nothing is required of the limits", () => {
		// Same runtime family, two records: no note, and a state naming the older one need not carry runtime-differs.
		const same = snapshotOf(records({ list: [older, pi], named: older, stateRuntime: "pi" }));
		expect(note(same)).toBeUndefined();
		expect(admitted(same.runtimes[0].capabilities).every((v: any) => runtimeDiffers(v) === undefined)).toBe(true);
		expect(validateEndoCockpitSnapshotV0(same)).not.toBeNull();
	});

	it("a note that does not cite the state's fingerprint says nothing of it", () => {
		// older and pi share a family; acp is the odd one. The note cites pi (the older's family representative) and acp.
		for (const stateRuntime of ["pi", "acp"]) {
			const s = snapshotOf(records({ list: [older, acp, pi], named: older, stateRuntime }));
			expect(note(s).refs.map((r: { id: string }) => r.id)).not.toContain(aliasOf(older.id));
			expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
			// Whether the state runtime matches the family is not on the wire: removing the limit stays admissible.
			expect(validateEndoCockpitSnapshotV0(dropRuntimeDiffers(s))).not.toBeNull();
		}
	});

	it("a note that cites a set-aside fingerprint establishes nothing", () => {
		// The older acp record is foreign: it is set aside, and a note citing its position is refused outright.
		const s = snapshotOf(records({ list: [foreign(acp), pi], named: acp, stateRuntime: "pi" }));
		expect(note(s)).toBeUndefined();
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const forged = mutated(s, (x) => {
			x.runtimes[0].identity.notes.push({
				code: "runtime-disagreement",
				refs: [
					structuredClone(x.runtimes[0].identity.current.ref),
					{ ...structuredClone(x.runtimes[0].identity.current.ref), index: 0, id: aliasOf(acp.id) },
				],
			});
		});
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});

	it("canonical output from a real store: the note and the limit are produced, validate, and deleting the limit is refused", () => {
		const root = tempRoot();
		ingestAll(root, lifecycleEvents(FIXTURE));
		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		registry.append("fingerprint", acp as never);
		registry.append("fingerprint", pi as never);
		for (const record of evidenceMatching(base, acp))
			registry.append("evidence", { ...record, runtime: "pi" } as never);
		registry.append("state", { ...first, runtime: "pi", fingerprintId: acp.id } as never);
		// The whole log, read whole: the timeline's projection also checks its prefix digest against the real store.
		const snapshot = readEndoCockpitSnapshotV0(root, {
			limit: ENDO_COCKPIT_PAGE_MAX_LIMIT_V0,
			attachments: [ATTACHMENT],
		});
		expect(snapshot.timeline.window.hasMore).toBe(false);
		const runtime = snapshot.runtimes[0]!;
		const disagreement = runtime.identity.notes.find((n) => n.code === "runtime-disagreement");
		expect(disagreement?.refs.map((r) => r.domain === "harness-registry" && r.id)).toEqual([
			aliasOf(acp.id),
			aliasOf(pi.id),
		]);
		const admittedViews = runtime.capabilities.capabilities.filter((v) => v.status !== "unverified");
		expect(admittedViews.length).toBeGreaterThan(0);
		for (const view of admittedViews) expect(codes(view)).toContain("runtime-differs");
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
		expect(
			validateEndoCockpitSnapshotV0(dropRuntimeDiffers({ ...snapshot, runtimes: snapshot.runtimes })),
		).toBeNull();
	});

	// The wire also decides the converse: a note that leaves two fingerprints in one family (or no note) makes the state differ from
	// both of them or from neither, so a limit citing exactly one of them cannot have been produced.
	it("fingerprints in one family: the limit cites the state's fingerprint and the latest one together, or neither (no note)", () => {
		const s = snapshotOf(records({ list: [older, pi], named: older, stateRuntime: "acp" }));
		expect(note(s)).toBeUndefined();
		for (const view of admitted(s.runtimes[0].capabilities))
			expect(runtimeDiffers(view).refs.map((r: { kind: string }) => r.kind)).toEqual([
				"state",
				"fingerprint",
				"fingerprint",
			]);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const named = refOf(s, aliasOf(older.id));
		const latest = refOf(s, aliasOf(pi.id));
		for (const only of [[named], [latest]])
			expect(validateEndoCockpitSnapshotV0(setRuntimeRefs(s, () => structuredClone(only)))).toBeNull();
		// Citing both, as produced, and neither (the state matches the family) are both fine.
		expect(
			validateEndoCockpitSnapshotV0(setRuntimeRefs(s, () => [structuredClone(named), structuredClone(latest)])),
		).not.toBeNull();
		const matching = snapshotOf(records({ list: [older, pi], named: older, stateRuntime: "pi" }));
		expect(admitted(matching.runtimes[0].capabilities).every((v: any) => runtimeDiffers(v) === undefined)).toBe(true);
		expect(validateEndoCockpitSnapshotV0(matching)).not.toBeNull();
	});

	it("fingerprints in one family beside an earlier one of another: a note citing only earlier fingerprints still ties the two", () => {
		// acp, then two pi: the note cites the acp one and the latest pi; the state's fingerprint is the older pi (not cited), and no
		// cited fingerprint but the latest comes after it, so it shares the latest's family.
		const s = snapshotOf(records({ list: [acp, older, pi], named: older, stateRuntime: "zed" }));
		expect(note(s).refs.map((r: { id: string }) => r.id)).toEqual([aliasOf(acp.id), aliasOf(pi.id)]);
		for (const view of admitted(s.runtimes[0].capabilities))
			expect(runtimeDiffers(view).refs.map((r: { id: string | null }) => r.id)).toEqual([
				null,
				aliasOf(older.id),
				aliasOf(pi.id),
			]);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const named = refOf(s, aliasOf(older.id));
		const latest = refOf(s, aliasOf(pi.id));
		for (const only of [[named], [latest]])
			expect(validateEndoCockpitSnapshotV0(setRuntimeRefs(s, () => structuredClone(only)))).toBeNull();
		for (const stateRuntime of ["pi", "acp"])
			expect(
				validateEndoCockpitSnapshotV0(snapshotOf(records({ list: [acp, older, pi], named: older, stateRuntime }))),
			).not.toBeNull();
	});

	it("a cited fingerprint that may come after the state's uncited one leaves the relation open", () => {
		// The state's fingerprint is the OLDEST: nothing shows where it sits, and the note cites a middle fingerprint, which may be
		// the representative of its family. Neither tying the two nor separating them is established.
		const s = snapshotOf(records({ list: [older, acp, pi], named: older, stateRuntime: "zed" }));
		expect(note(s).refs.map((r: { id: string }) => r.id)).not.toContain(aliasOf(older.id));
		const latest = refOf(s, aliasOf(pi.id));
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(setRuntimeRefs(s, () => [structuredClone(latest)]))).not.toBeNull();
	});
});
