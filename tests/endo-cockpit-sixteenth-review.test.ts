// PR #57 review round 16: cross-kind id ownership (a notice naming a fingerprint's id, a state naming an evidence id), the
// id ledger's order for duplicate notes, details-carrier usage, store-opened discontinuity, unreadable sources and
// discarded records in runtime disagreement. Every negative is its own test so each fails for its own reason.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cockpitAliasesV0, registryWatermarkV0 } from "../cockpit/projections/common.ts";
import {
	type EndoCockpitSessionTimelineV0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import { endoHarnessIdentityBasisV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	changeRecord,
	event,
	notificationRecord,
	removeTempRoots,
	specimen,
	specimenRecords,
	stored,
} from "./cockpit-fixtures.ts";
import {
	projectEndoCockpitCapabilityStateV0,
	projectEndoCockpitRuntimeIdentityV0,
	projectEndoCockpitSessionTimelineV0,
	readAs,
	TEST_KEY,
} from "./cockpit-keyed.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const CLEAN = { state: "readable", tornTail: null, sealedAt: null, error: null } as const;
const mutated = <T>(value: T, edit: (copy: any) => void): T => {
	const copy = structuredClone(value);
	edit(copy);
	return copy;
};
const aliasOf = (id: string) => cockpitAliasesV0(TEST_KEY).id(id);

function registryInput(records: ReturnType<typeof specimenRecords>, condition: Record<string, unknown> = {}) {
	const total = Object.values(records).reduce((sum, list) => sum + list.length, 0);
	const state = total === 0 ? ("empty" as const) : ("readable" as const);
	return {
		source: {
			domain: "harness-registry" as const,
			attachment: "pi.default",
			condition: { ...CLEAN, state, ...condition },
			watermark: registryWatermarkV0(TEST_KEY, (condition.state as never) ?? state, records),
		},
		records,
	} as never;
}

function fingerprintAt(realPath: string, runtime = "pi") {
	const base = specimen().fingerprint;
	const local = { ...base.local, realPath };
	const identity = {
		digest: sha256HexV0(
			canonicalEndoJsonV0(endoHarnessIdentityBasisV0({ runtime: "pi", local, reported: base.reported })),
		),
		confidence: base.identity.confidence,
	};
	const { id: _id, ...rest } = base;
	const body = { ...rest, local, identity, runtime };
	return { ...body, id: `endo.evidence.pi-fingerprint.${sha256HexV0(canonicalEndoJsonV0(body))}` };
}
const foreign = <T extends object>(item: T) => ({ ...item, attachment: "other.attachment" });
const identityOf = (records: unknown, condition: Record<string, unknown> = {}) =>
	projectEndoCockpitRuntimeIdentityV0(registryInput(records as never, condition), TEST_KEY);
const capabilitiesOf = (records: unknown, condition: Record<string, unknown> = {}) =>
	projectEndoCockpitCapabilityStateV0(registryInput(records as never, condition), TEST_KEY);

const timeline = (() => {
	const one = event("agent.prompt-accepted");
	return projectEndoCockpitSessionTimelineV0(
		readAs(
			{
				source: {
					domain: "event-log",
					condition: { ...CLEAN },
					watermark: {
						length: 1,
						lastEventId: aliasOf(one.id),
						prefixDigest: sha256HexV0("p"),
						keyId: TEST_KEY.keyId,
					},
				},
				afterSequence: 0,
				events: stored([one]),
			} as never,
			TEST_KEY,
		),
		TEST_KEY,
	);
})();
const snapshotOf = (records: unknown) => ({
	schemaVersion: "endo.cockpit-snapshot.v0",
	projectionVersion: "cockpit-snapshot.3",
	consistency: "independent-sources",
	timeline,
	runtimes: [{ identity: identityOf(records), capabilities: capabilitiesOf(records) }],
});
const withoutNote = <T extends { notes: { code: string }[] }>(value: T, code: string) =>
	mutated(value, (x) => {
		x.notes = x.notes.filter((n: { code: string }) => n.code !== code);
	});

const [fa, fb, fc, fd] = ["/a/pi", "/b/pi", "/c/pi", "/d/pi"].map((path) => fingerprintAt(path)) as [
	ReturnType<typeof fingerprintAt>,
	ReturnType<typeof fingerprintAt>,
	ReturnType<typeof fingerprintAt>,
	ReturnType<typeof fingerprintAt>,
];
const c1 = changeRecord({ id: "endo.evidence.test-change.1" });
const c2 = changeRecord({ id: "endo.evidence.test-change.2" });
const notice = (changeId: string, id = "endo.evidence.test-notification.1") => notificationRecord({ id, changeId });

// ---------------------------------------------------------------------------------------------------------------
// 1. A notice naming a presented non-change id names no change
// ---------------------------------------------------------------------------------------------------------------

describe("a notice naming a presented fingerprint's id requires its note, however many changes are kept (P2)", () => {
	const base = specimenRecords();
	const identity = (changeId: string, extra: Record<string, unknown> = {}) =>
		identityOf({
			...base,
			fingerprint: [fa, fb],
			change: [c1, c2],
			notification: [notice(changeId)],
			...extra,
		});
	const missing = (i: { notes: { code: string }[] }) =>
		i.notes.filter((n) => n.code === "notification-change-missing");

	it("requires the note for the current fingerprint's id, and accepts the projector's output", () => {
		const i = identity(fb.id);
		expect(missing(i)).toHaveLength(1);
		expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withoutNote(i, "notification-change-missing"))).toBeNull();
	});

	it("requires the note for the previous different fingerprint's id", () => {
		const i = identity(fa.id);
		expect(i.previousDifferent?.id).toBe(aliasOf(fa.id));
		expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withoutNote(i, "notification-change-missing"))).toBeNull();
	});

	it("requires the note for the notice's own id", () => {
		const own = "endo.evidence.test-notification.1";
		const i = identity(own);
		expect(validateEndoCockpitRuntimeIdentityV0(withoutNote(i, "notification-change-missing"))).toBeNull();
	});

	it("refuses a note naming another record", () => {
		const i = identity(fb.id);
		const wrong = mutated(i, (x) => {
			x.notes.find((n: { code: string }) => n.code === "notification-change-missing").refs = [
				structuredClone(x.current.ref),
			];
		});
		expect(validateEndoCockpitRuntimeIdentityV0(wrong)).toBeNull();
	});

	it("leaves the note optional for a historical change, and for the id of a foreign or unpresented record", () => {
		const earlier = identity(c1.id);
		expect(missing(earlier)).toHaveLength(0);
		expect(validateEndoCockpitRuntimeIdentityV0(earlier)).not.toBeNull();
		// An id not presented as any kept record (a foreign fingerprint's, a third fingerprint's): undecidable.
		const foreignId = identityOf({
			...base,
			fingerprint: [foreign(fa), fb, fc],
			change: [c1, c2],
			notification: [notice(fa.id)],
		});
		expect(missing(foreignId)).toHaveLength(1);
		expect(
			validateEndoCockpitRuntimeIdentityV0(withoutNote(foreignId, "notification-change-missing")),
		).not.toBeNull();
		const unpresented = identityOf({
			...base,
			fingerprint: [fa, fb, fc, fd],
			change: [c1, c2],
			notification: [notice(fa.id)],
		});
		expect(unpresented.previousDifferent?.id).not.toBe(aliasOf(fa.id));
		expect(
			validateEndoCockpitRuntimeIdentityV0(withoutNote(unpresented, "notification-change-missing")),
		).not.toBeNull();
	});

	it("applies across a snapshot: a notice naming a cited evidence id requires its note", () => {
		const cited = base.state[0]!.capabilities.find((c) => c.status !== "unverified" && c.evidenceId !== null)!
			.evidenceId!;
		const records = { ...base, fingerprint: [fa, fb], change: [c1, c2], notification: [notice(cited)] };
		const s = snapshotOf(records);
		expect(s.runtimes[0]!.capabilities.capabilities.some((v) => v.evidence?.id === aliasOf(cited))).toBe(true);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		// Each view alone cannot tell (several changes); the snapshot can.
		const forged = mutated(s, (x) => {
			x.runtimes[0].identity.notes = x.runtimes[0].identity.notes.filter(
				(n: { code: string }) => n.code !== "notification-change-missing",
			);
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forged.runtimes[0]!.identity)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. A state naming a presented non-fingerprint id names no fingerprint
// ---------------------------------------------------------------------------------------------------------------

describe("a state naming a cited evidence id requires the unrecorded-fingerprint limit (P2)", () => {
	const base = specimenRecords();
	const citedIds = base.state[0]!.capabilities.flatMap((c) => (c.evidenceId === null ? [] : [c.evidenceId]));
	const admittedCited = base.state[0]!.capabilities.find((c) => c.status !== "unverified" && c.evidenceId !== null)!
		.evidenceId!;
	const uncited = base.evidence.find((item) => !citedIds.includes(item.id))!.id;
	const project = (fingerprintId: string, fingerprint: unknown[] = [fa, fb], state = base.state[0]!) =>
		capabilitiesOf({ ...base, fingerprint, state: [{ ...state, fingerprintId }] });
	const codes = (v: { limits: { code: string }[] }) => v.limits.map((l) => l.code);
	const dropped = (p: ReturnType<typeof project>) =>
		mutated(p, (x) => {
			for (const view of x.capabilities)
				view.limits = view.limits.filter((l: { code: string }) => l.code !== "state-fingerprint-not-recorded");
		});

	it("requires the limit when several fingerprints are kept and the state names a cited evidence id", () => {
		const p = project(admittedCited);
		expect(p.state!.fingerprintId).toBe(aliasOf(admittedCited));
		const admitted = p.capabilities.filter((c) => c.status !== "unverified");
		expect(admitted.every((c) => codes(c).includes("state-fingerprint-not-recorded"))).toBe(true);
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(dropped(p))).toBeNull();
	});

	it("requires it from every admitted capability, though only one cites that evidence", () => {
		const p = project(admittedCited);
		const one = mutated(p, (x) => {
			const view = x.capabilities.filter((c: any) => c.status !== "unverified").at(-1);
			view.limits = view.limits.filter((l: { code: string }) => l.code !== "state-fingerprint-not-recorded");
		});
		expect(validateEndoCockpitCapabilityStateV0(one)).toBeNull();
	});

	it("keeps it optional for a historical id, and for the id of an evidence record no capability cites", () => {
		for (const name of ["endo.evidence.pi-fingerprint.historical", uncited]) {
			const p = project(name);
			expect(
				p.capabilities.some((c) => codes(c).includes("state-fingerprint-not-recorded")),
				name,
			).toBe(true);
			expect(validateEndoCockpitCapabilityStateV0(dropped(p)), name).not.toBeNull();
		}
	});

	it("does not demand it from unverified entries, nor when the named fingerprint is kept", () => {
		const first = base.state[0]!;
		const unverified = {
			...first,
			capabilities: first.capabilities.map((c) => ({
				...c,
				status: "unverified",
				classification: null,
				evidenceId: null,
			})),
		};
		const p = project(admittedCited, [fa, fb], unverified as never);
		expect(p.capabilities.every((c) => !codes(c).includes("state-fingerprint-not-recorded"))).toBe(true);
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		const kept = project(fb.id);
		expect(kept.capabilities.every((c) => !codes(c).includes("state-fingerprint-not-recorded"))).toBe(true);
		expect(validateEndoCockpitCapabilityStateV0(kept)).not.toBeNull();
	});

	it("applies across a snapshot: a state naming the last change's or notice's id requires the limit", () => {
		const records = (id: string) => ({
			...base,
			// Three kept, two embedded: "every kept fingerprint is embedded" cannot be what requires the limit.
			fingerprint: [fa, fb, fc],
			change: [c1],
			notification: [notice(c1.id)],
			state: [{ ...base.state[0]!, fingerprintId: id }],
		});
		for (const id of [c1.id, "endo.evidence.test-notification.1"]) {
			const s = snapshotOf(records(id));
			expect(validateEndoCockpitSnapshotV0(s), id).not.toBeNull();
			const forged = mutated(s, (x) => {
				for (const view of x.runtimes[0].capabilities.capabilities)
					view.limits = view.limits.filter((l: { code: string }) => l.code !== "state-fingerprint-not-recorded");
			});
			expect(validateEndoCockpitCapabilityStateV0(forged.runtimes[0]!.capabilities), id).not.toBeNull();
			expect(validateEndoCockpitSnapshotV0(forged), id).toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. A duplicate note is checked against the ledger the cleaner kept
// ---------------------------------------------------------------------------------------------------------------

describe("a duplicate-record-id note follows the cleaner's id ledger (P2)", () => {
	const base = specimenRecords();
	/** Evidence whose first record repeats `id` (a record of an earlier kind). */
	const repeating = (id: string) => base.evidence.map((item, at) => (at === 0 ? { ...item, id } : item));
	const dupOf = (p: { notes: { code: string; refs: unknown[] }[] }) =>
		p.notes.find((n) => n.code === "duplicate-record-id")!;
	const withId = <T extends { notes: any[] }>(value: T, id: string) =>
		mutated(value, (x) => {
			x.notes.find((n: any) => n.code === "duplicate-record-id").refs[0].id = id;
		});

	it("Codex's case: one kept fingerprint, no changes, evidence 0 repeating it must carry its id", () => {
		const p = capabilitiesOf({ ...base, fingerprint: [fa], evidence: repeating(fa.id) });
		expect((dupOf(p).refs[0] as { index: number; id: string }).id).toBe(aliasOf(fa.id));
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(withId(p, aliasOf("endo.evidence.arbitrary")))).toBeNull();
	});

	it("a foreign fingerprint never enters the ledger; the kept one after it does", () => {
		const kept = capabilitiesOf({ ...base, fingerprint: [foreign(fa), fb], evidence: repeating(fb.id) });
		expect(validateEndoCockpitCapabilityStateV0(kept)).not.toBeNull();
		// Repeating the foreign fingerprint's id is no duplicate: the cleaner keeps that evidence record.
		const notDuplicate = capabilitiesOf({ ...base, fingerprint: [foreign(fa), fb], evidence: repeating(fa.id) });
		expect(notDuplicate.notes.some((n) => n.code === "duplicate-record-id")).toBe(false);
		const forged = mutated(kept, (x) => {
			x.notes.find((n: any) => n.code === "duplicate-record-id").refs[0].id = aliasOf(fa.id);
		});
		expect(validateEndoCockpitCapabilityStateV0(forged)).toBeNull();
	});

	it("rejects the note when no earlier record can exist", () => {
		const p = capabilitiesOf({ ...base, fingerprint: [], evidence: repeating("endo.evidence.arbitrary") });
		expect(p.notes.some((n) => n.code === "duplicate-record-id")).toBe(false);
		const forged = mutated(p, (x) => {
			x.notes.push({
				code: "duplicate-record-id",
				refs: [
					{ ...structuredClone(x.state.ref), kind: "evidence", index: 0, id: aliasOf("endo.evidence.arbitrary") },
				],
			});
		});
		expect(validateEndoCockpitCapabilityStateV0(forged)).toBeNull();
	});

	it("does not infer ids it cannot see: older kept fingerprints, changes, an unexposed neighbour", () => {
		// Two kept fingerprints: only the latest is exposed, so the older one's id may legitimately be repeated.
		const older = capabilitiesOf({ ...base, fingerprint: [fa, fb], evidence: repeating(fa.id) });
		expect(dupOf(older)).toBeDefined();
		expect(validateEndoCockpitCapabilityStateV0(older)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(withId(older, aliasOf("endo.evidence.unseen")))).not.toBeNull();
		// A change (not cleaned by this view) may be the one repeated.
		const change = capabilitiesOf({ ...base, fingerprint: [], change: [c1], evidence: repeating(c1.id) });
		expect(validateEndoCockpitCapabilityStateV0(change)).not.toBeNull();
		// The identity view: a notice repeating an id, with evidence it does not clean.
		const identity = identityOf({
			...base,
			fingerprint: [fa, fb],
			notification: [
				notice("endo.evidence.x", fa.id),
				notice("endo.evidence.x", "endo.evidence.test-notification.2"),
			],
		});
		expect(dupOf(identity)).toBeDefined();
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withId(identity, aliasOf("endo.evidence.unseen")))).not.toBeNull();
	});
});

describe("the ledger rule sees the latest kept id, the whole snapshot, and the owner's position (P2)", () => {
	const base = specimenRecords();
	const repeating = (id: string) => base.evidence.map((item, at) => (at === 0 ? { ...item, id } : item));
	const forgeId = <T extends { notes: any[] }>(value: T, id: string) =>
		mutated(value, (x) => {
			x.notes.find((n: any) => n.code === "duplicate-record-id").refs[0].id = id;
		});

	it("locates the latest kept fingerprint through the cleaning notes when a state names it", () => {
		const records = { ...base, fingerprint: [fa, foreign(fb)], evidence: repeating(fa.id) };
		const p = capabilitiesOf(records);
		expect(p.state!.latestFingerprintId).toBe(aliasOf(fa.id));
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(forgeId(p, aliasOf("endo.evidence.arbitrary")))).toBeNull();
		// With no state nothing names the latest kept fingerprint: the earlier set is incomplete, so any id may be it.
		const stateless = capabilitiesOf({ ...records, state: [] });
		expect(validateEndoCockpitCapabilityStateV0(stateless)).not.toBeNull();
	});

	it("checks a capability note against the identity view's change dispositions in a snapshot", () => {
		const records = { ...base, fingerprint: [], change: [c1], evidence: repeating(c1.id) };
		const s = snapshotOf(records);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const forged = mutated(s, (x) => {
			x.runtimes[0].capabilities.notes.find((n: any) => n.code === "duplicate-record-id").refs[0].id =
				aliasOf("endo.evidence.arbitrary");
		});
		// The capability view alone cannot see its changes; the snapshot holds them.
		expect(validateEndoCockpitCapabilityStateV0(forged.runtimes[0]!.capabilities)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});

	it("refuses a repeated id that a kept record presented later already owns", () => {
		const records = { ...base, fingerprint: [fa, fb], evidence: repeating(fa.id) };
		const p = capabilitiesOf(records);
		const later = p.capabilities.find(
			(v) => v.evidence !== null && (v.evidence.ref as { index: number }).index >= 1,
		)!;
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(forgeId(p, later.evidence!.id))).toBeNull();
		// The earlier fingerprint's id (not exposed, but earlier) remains acceptable.
		expect(validateEndoCockpitCapabilityStateV0(forgeId(p, aliasOf("endo.evidence.unseen")))).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. A shown details field proves the details carrier
// ---------------------------------------------------------------------------------------------------------------

describe("the no-details usage reason contradicts a shown details field (P2)", () => {
	const NO_DETAILS = "the event records no entry details";
	const entryOf = (payload: Record<string, unknown>) => {
		const one = event("session.entry-observed", payload);
		return projectEndoCockpitSessionTimelineV0(
			readAs(
				{
					source: {
						domain: "event-log",
						condition: { ...CLEAN },
						watermark: {
							length: 1,
							lastEventId: aliasOf(one.id),
							prefixDigest: sha256HexV0("p"),
							keyId: TEST_KEY.keyId,
						},
					},
					afterSequence: 0,
					events: stored([one]),
				} as never,
				TEST_KEY,
			),
			TEST_KEY,
		);
	};
	const reason = (t: EndoCockpitSessionTimelineV0, text: string) =>
		mutated(t, (x) => {
			x.entries[0].usage = { basis: "unavailable", reason: text };
		});
	const ok = (t: unknown) => validateEndoCockpitSessionTimelineV0(t) !== null;

	it("refuses it beside a presented details.role", () => {
		const t = entryOf({ entryType: "message", details: { role: "assistant" } });
		expect(t.entries[0]!.fields.role).toBeDefined();
		expect(t.entries[0]!.usage).toMatchObject({ reason: "the event records no usage" });
		expect(ok(t)).toBe(true);
		expect(ok(reason(t, NO_DETAILS))).toBe(false);
	});

	it("refuses it beside any other details field, including a withheld one", () => {
		for (const details of [
			{ stopReason: "stop" },
			{ tokensBefore: 3 },
			{ firstKeptEntryId: "e-1" },
			{ role: "/home/alice/x" },
		]) {
			const t = entryOf({ entryType: "compaction", details });
			expect(t.entries[0]!.usage, JSON.stringify(details)).not.toBeNull();
			expect(ok(reason(t, NO_DETAILS)), JSON.stringify(details)).toBe(false);
		}
	});

	it("accepts it where nothing proves the carrier, and keeps the other reasons distinct", () => {
		const none = entryOf({ entryType: "usage" });
		expect(none.entries[0]!.usage).toMatchObject({ reason: NO_DETAILS });
		expect(ok(none)).toBe(true);
		// Details that exist but show no field: nothing is proven, so the reason is not refused (and the projector says no usage).
		const empty = entryOf({ entryType: "usage", details: {} });
		expect(empty.entries[0]!.usage).toMatchObject({ reason: "the event records no usage" });
		expect(ok(reason(empty, NO_DETAILS))).toBe(true);
		const malformed = entryOf({ entryType: "message", details: { role: "assistant", usage: { input: "x" } } });
		expect(malformed.entries[0]!.usage).toMatchObject({ reason: "the recorded usage is not in the expected shape" });
		expect(ok(malformed)).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Discontinuity of a reopened store needs a shown cause
// ---------------------------------------------------------------------------------------------------------------

describe("a store-opened discontinuity needs a shown true recovery value (P2)", () => {
	const opened = (recovery: Record<string, unknown> | undefined) => {
		const one = event("harness.store-opened", {
			lifecycleRepaired: 0,
			...(recovery === undefined ? {} : { recovery }),
		});
		return projectEndoCockpitSessionTimelineV0(
			readAs(
				{
					source: {
						domain: "event-log",
						condition: { ...CLEAN },
						watermark: {
							length: 1,
							lastEventId: aliasOf(one.id),
							prefixDigest: sha256HexV0("p"),
							keyId: TEST_KEY.keyId,
						},
					},
					afterSequence: 0,
					events: stored([one]),
				} as never,
				TEST_KEY,
			),
			TEST_KEY,
		);
	};
	const ok = (t: unknown) => validateEndoCockpitSessionTimelineV0(t) !== null;
	const without = (t: EndoCockpitSessionTimelineV0, key: string) =>
		mutated(t, (x) => {
			delete x.entries[0].fields[key];
		});

	it("refuses the flag once the only true value is removed", () => {
		const t = opened({ truncated: true });
		expect(t.entries[0]!.flags).toContain("discontinuity");
		expect(ok(t)).toBe(true);
		expect(ok(without(t, "recoveryTruncated"))).toBe(false);
	});

	it("keeps the flag valid while any shown value is true", () => {
		const t = opened({ truncated: true, recovered: true, sealed: false });
		expect(ok(without(t, "recoveryTruncated"))).toBe(true);
		expect(ok(without(without(t, "recoveryTruncated"), "recoveryRecovered"))).toBe(false);
	});

	it("still requires the flag for a shown true, forbids it for all false, and leaves partial entries unflagged", () => {
		const t = opened({ sealed: true });
		expect(
			ok(
				mutated(t, (x) => {
					x.entries[0].flags = [];
				}),
			),
		).toBe(false);
		const clean = opened({ truncated: false, recovered: false, sealed: false });
		expect(ok(clean)).toBe(true);
		expect(
			ok(
				mutated(clean, (x) => {
					x.entries[0].flags = ["discontinuity"];
				}),
			),
		).toBe(false);
		for (const recovery of [undefined, { truncated: false }, { recovered: "yes" }]) {
			const partial = opened(recovery);
			expect(partial.entries[0]!.flags).not.toContain("discontinuity");
			expect(ok(partial)).toBe(true);
			expect(
				ok(
					mutated(partial, (x) => {
						x.entries[0].flags = ["discontinuity"];
					}),
				),
			).toBe(false);
		}
	});

	it("does not generalise to other kinds: a runtime change is discontinuous by what it is", () => {
		const one = event("harness.runtime-changed", {
			previousFingerprintId: "endo.evidence.a",
			currentFingerprintId: "endo.evidence.b",
		});
		const t = projectEndoCockpitSessionTimelineV0(
			readAs(
				{
					source: {
						domain: "event-log",
						condition: { ...CLEAN },
						watermark: {
							length: 1,
							lastEventId: aliasOf(one.id),
							prefixDigest: sha256HexV0("p"),
							keyId: TEST_KEY.keyId,
						},
					},
					afterSequence: 0,
					events: stored([one]),
				} as never,
				TEST_KEY,
			),
			TEST_KEY,
		);
		expect(t.entries[0]!.flags).toContain("discontinuity");
		expect(ok(t)).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 6. An unread source claims nothing about its history
// ---------------------------------------------------------------------------------------------------------------

describe("an unreadable source carries only source-not-projectable (P2)", () => {
	const unopenable = {
		source: {
			domain: "harness-registry",
			attachment: "pi.default",
			condition: {
				state: "unopenable",
				tornTail: null,
				sealedAt: null,
				error: { kind: "invalid-store", message: "the store could not be opened" },
			},
			watermark: null,
		},
		records: null,
	} as never;
	const sources = {
		absent: () => ({
			source: {
				domain: "harness-registry",
				attachment: "pi.default",
				condition: { ...CLEAN, state: "absent" },
				watermark: registryWatermarkV0(TEST_KEY, "absent", null),
			},
			records: null,
		}),
		unopenable: () => unopenable,
	};
	const extra = (code: string) => ({ code, refs: [] });

	for (const [name, make] of Object.entries(sources))
		for (const code of [
			"no-fingerprint-recorded",
			"runtime-disagreement",
			"notification-change-missing",
			"latest-change-is-collection-failure",
		]) {
			it(`${name}: refuses an added ${code} in the identity`, () => {
				const i = projectEndoCockpitRuntimeIdentityV0(make() as never, TEST_KEY);
				expect(i.notes.map((n) => n.code)).toEqual(["source-not-projectable"]);
				expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
				expect(validateEndoCockpitRuntimeIdentityV0(mutated(i, (x) => void x.notes.push(extra(code))))).toBeNull();
			});
		}

	for (const [name, make] of Object.entries(sources))
		for (const code of ["no-capability-state-recorded", "state-without-fingerprint", "duplicate-capability"]) {
			it(`${name}: refuses an added ${code} in the capability state`, () => {
				const p = projectEndoCockpitCapabilityStateV0(make() as never, TEST_KEY);
				expect(p.notes.map((n) => n.code)).toEqual(["source-not-projectable"]);
				expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
				expect(validateEndoCockpitCapabilityStateV0(mutated(p, (x) => void x.notes.push(extra(code))))).toBeNull();
			});
		}

	it("keeps inspected-empty semantics for a readable empty registry and a degraded one with no records", () => {
		const empty = { fingerprint: [], change: [], evidence: [], state: [], notification: [] };
		for (const condition of [{}, { state: "degraded", tornTail: { bytes: 3, digest: "a".repeat(64) } }]) {
			const i = identityOf(empty, condition);
			expect(
				i.notes.map((n) => n.code),
				JSON.stringify(condition),
			).toEqual(["no-fingerprint-recorded"]);
			expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
			expect(validateEndoCockpitRuntimeIdentityV0(withoutNote(i, "no-fingerprint-recorded"))).toBeNull();
			const p = capabilitiesOf(empty, condition);
			expect(p.notes.map((n) => n.code)).toEqual(["no-capability-state-recorded"]);
			expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 7. Disagreement is among kept records
// ---------------------------------------------------------------------------------------------------------------

describe("a runtime-disagreement note cites kept records (P2)", () => {
	const other = (path: string) => fingerprintAt(path, "other");
	const disagreement = (i: { notes: { code: string; refs: unknown[] }[] }) =>
		i.notes.find((n) => n.code === "runtime-disagreement");
	const noteWith = (i: ReturnType<typeof identityOf>, refs: unknown[]) =>
		mutated(i, (x) => {
			x.notes = x.notes.filter((n: { code: string }) => n.code !== "runtime-disagreement");
			x.notes.push({ code: "runtime-disagreement", refs: structuredClone(refs) });
		});
	it("refuses a foreign discard cited as one of the two families", () => {
		const records = { ...specimenRecords(), fingerprint: [foreign(other("/x/pi")), fa] };
		const i = identityOf(records);
		expect(disagreement(i)).toBeUndefined();
		const forged = noteWith(i, [
			{ ...(i.current!.ref as object), index: 0, id: aliasOf(records.fingerprint[0]!.id) },
			i.current!.ref,
		]);
		expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	it("refuses a duplicate discard, and a discard disguised under another id", () => {
		const records = { ...specimenRecords(), fingerprint: [fa, { ...other("/x/pi"), id: fa.id }, fb] };
		const i = identityOf(records);
		expect(i.notes.some((n) => n.code === "duplicate-record-id")).toBe(true);
		expect(disagreement(i)).toBeUndefined();
		for (const id of [aliasOf(fa.id), "endo.evidence.pi-fingerprint.disguised"]) {
			const forged = noteWith(i, [{ ...(i.current!.ref as object), index: 1, id }, i.current!.ref]);
			expect(validateEndoCockpitRuntimeIdentityV0(forged), id).toBeNull();
		}
	});

	it("refuses a discarded change", () => {
		const records = {
			...specimenRecords(),
			fingerprint: [fa],
			change: [foreign(changeRecord({ id: "endo.evidence.test-change.9", runtime: "other" } as never)), c1],
		};
		const i = identityOf(records);
		expect(disagreement(i)).toBeUndefined();
		const forged = noteWith(i, [
			i.current!.ref,
			{ ...(i.lastChange!.ref as object), index: 0, id: aliasOf("endo.evidence.test-change.9") },
		]);
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	it("accepts the projector's note citing a kept record the summary views omit", () => {
		// a is the only 'other'; b, c, d are 'pi': a (index 0) is neither current nor previousDifferent.
		const records = { ...specimenRecords(), fingerprint: [other("/a/pi"), fb, fc, fd] };
		const i = identityOf(records);
		const note = disagreement(i)!;
		expect(note.refs).toHaveLength(2);
		expect(note.refs.map((r) => (r as { index: number }).index)).toContain(0);
		expect(i.previousDifferent!.ref).toMatchObject({ index: 2 });
		expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
	});

	it("keeps requiring distinct kept records, and the latest kept fingerprint", () => {
		const records = { ...specimenRecords(), fingerprint: [other("/a/pi"), fb] };
		const i = identityOf(records);
		expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(noteWith(i, [i.current!.ref, i.current!.ref]))).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Soundness: whatever the projectors produce validates, in both views and the snapshot
// ---------------------------------------------------------------------------------------------------------------

describe("every projector output over a matrix of cleaned histories validates (soundness)", () => {
	const base = specimenRecords();
	const fingerprintSets: [string, unknown[]][] = [
		["none", []],
		["one", [fa]],
		["foreign first", [foreign(fa), fb]],
		["foreign tail", [fa, foreign(fb)]],
		["duplicate", [fa, { ...fa }, fb]],
		["four", [fa, fb, fc, fd]],
		["all foreign", [foreign(fa), foreign(fb)]],
	];
	const changeSets: [string, unknown[]][] = [
		["none", []],
		["one", [c1]],
		["two", [c1, c2]],
		["foreign tail", [c1, foreign(c2)]],
	];
	const evidenceModes = ["plain", "repeats fingerprint", "repeats change", "change repeats fingerprint"] as const;
	const stateModes = ["state", "no state"] as const;
	const notices = ["kept change", "unrelated", "kept fingerprint", "foreign fingerprint"] as const;

	it("accepts all of them (the projectors validate their own output, so a refusal is a TypeError)", () => {
		let run = 0;
		for (const [fname, fingerprint] of fingerprintSets)
			for (const [cname, change] of changeSets)
				for (const mode of evidenceModes)
					for (const stateMode of stateModes)
						for (const kind of notices) {
							const kept = (fingerprint as { id: string; attachment: string }[]).find(
								(f) => f.attachment === "pi.default",
							);
							const firstChange = (change as { id: string }[])[0];
							const evidence = base.evidence.map((item, at) =>
								at !== 0
									? item
									: mode === "repeats fingerprint" && kept !== undefined
										? { ...item, id: kept.id }
										: mode === "repeats change" && firstChange !== undefined && change.length > 1
											? { ...item, id: firstChange.id }
											: item,
							);
							const changeId =
								kind === "kept change"
									? (firstChange?.id ?? "endo.evidence.test-change.7")
									: kind === "kept fingerprint"
										? (kept?.id ?? "endo.evidence.x")
										: kind === "foreign fingerprint"
											? ((fingerprint as { id: string }[])[0]?.id ?? "endo.evidence.x")
											: "endo.evidence.unrelated";
							const changes =
								mode === "change repeats fingerprint" && kept !== undefined && change.length > 1
									? [{ ...(change[0] as object), id: kept.id }, ...change.slice(1)]
									: change;
							const records = {
								...base,
								fingerprint,
								change: changes,
								evidence,
								state: stateMode === "state" ? base.state : [],
								notification: [notice(changeId)],
							};
							const label = [fname, cname, mode, stateMode, kind].join(" / ");
							try {
								const s = snapshotOf(records);
								expect(validateEndoCockpitSnapshotV0(s), label).not.toBeNull();
								run += 1;
							} catch (error) {
								throw new Error(`${label}: ${(error as Error).message}`);
							}
						}
		expect(run).toBeGreaterThan(100);
	});
});
