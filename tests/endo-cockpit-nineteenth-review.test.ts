// PR #57 review round 19: a valid duplicate note establishes the KIND of the earlier owner of its id (when every possible owner
// has that kind), the source-kind predicate enforces the kind grammar, and a fingerprint field is an evidence identifier.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cockpitAliasesV0, registryWatermarkV0 } from "../cockpit/projections/common.ts";
import {
	ENDO_COCKPIT_LIMIT_CODES_V0,
	type EndoCockpitSessionTimelineV0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import { isEndoCockpitSourceKindAdmittedV0 } from "../protocol/cockpit-fields.ts";
import { endoHarnessIdentityBasisV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	changeRecord,
	event,
	ingestAll,
	notificationRecord,
	removeTempRoots,
	specimen,
	specimenRecords,
	stored,
	tempRoot,
	treeHash,
} from "./cockpit-fixtures.ts";
import {
	projectEndoCockpitCapabilityStateV0,
	projectEndoCockpitRuntimeIdentityV0,
	projectEndoCockpitSessionTimelineV0,
	readAs,
	readEndoCockpitTimelineV0,
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
const rank = (code: string) => ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(code as never);

function registryInput(records: ReturnType<typeof specimenRecords>) {
	const total = Object.values(records).reduce((sum, list) => sum + list.length, 0);
	const state = total === 0 ? ("empty" as const) : ("readable" as const);
	return {
		source: {
			domain: "harness-registry" as const,
			attachment: "pi.default",
			condition: { ...CLEAN, state },
			watermark: registryWatermarkV0(TEST_KEY, state, records),
		},
		records,
	} as never;
}

function fingerprintAt(realPath: string) {
	const base = specimen().fingerprint;
	const local = { ...base.local, realPath };
	const identity = {
		digest: sha256HexV0(
			canonicalEndoJsonV0(endoHarnessIdentityBasisV0({ runtime: "pi", local, reported: base.reported })),
		),
		confidence: base.identity.confidence,
	};
	const { id: _id, ...rest } = base;
	const body = { ...rest, local, identity };
	return { ...body, id: `endo.evidence.pi-fingerprint.${sha256HexV0(canonicalEndoJsonV0(body))}` };
}
const foreign = <T extends object>(item: T) => ({ ...item, attachment: "other.attachment" });
const [fa, fb, fc] = ["/a/pi", "/b/pi", "/c/pi"].map(fingerprintAt) as [
	ReturnType<typeof fingerprintAt>,
	ReturnType<typeof fingerprintAt>,
	ReturnType<typeof fingerprintAt>,
];
const identityOf = (records: unknown) => projectEndoCockpitRuntimeIdentityV0(registryInput(records as never), TEST_KEY);
const capabilitiesOf = (records: unknown) =>
	projectEndoCockpitCapabilityStateV0(registryInput(records as never), TEST_KEY);
const logSource = (one: { id: string }) => ({
	domain: "event-log" as const,
	condition: { ...CLEAN },
	watermark: { length: 1, lastEventId: aliasOf(one.id), prefixDigest: sha256HexV0("p"), keyId: TEST_KEY.keyId },
});
const timelineOf = (one: ReturnType<typeof event>): EndoCockpitSessionTimelineV0 =>
	projectEndoCockpitSessionTimelineV0(
		readAs({ source: logSource(one), afterSequence: 0, events: stored([one]) } as never, TEST_KEY),
		TEST_KEY,
	);
const snapshotFrom = (identity: any, capabilities: any): any => ({
	schemaVersion: "endo.cockpit-snapshot.v0",
	projectionVersion: "cockpit-snapshot.3",
	consistency: "independent-sources",
	timeline: timelineOf(event("agent.prompt-accepted")),
	runtimes: [{ identity, capabilities }],
});
const snapshotOf = (records: unknown) => snapshotFrom(identityOf(records), capabilitiesOf(records));
const base = specimenRecords();
const first = base.state[0]!;
const codes = (v: { limits: { code: string }[] }) => v.limits.map((l) => l.code);
const admittedAt = (p: { capabilities: { status: string }[] }) =>
	p.capabilities.flatMap((c, at) => (c.status === "unverified" ? [] : [at]));
const c1 = changeRecord({ id: "endo.evidence.test-change.1" });
const c2 = changeRecord({ id: "endo.evidence.test-change.2" });
const c3 = changeRecord({ id: "endo.evidence.test-change.3" });
/** Evidence that matches `fa` (digest and fingerprint), so that no limit in the capability view cites it. */
const evidenceMatching = (target: { id: string; identity: { digest: string } }) =>
	base.evidence.map((item) => ({
		...item,
		dependencies: { ...item.dependencies, identityDigest: target.identity.digest, fingerprintId: target.id },
	}));
const withNotRecorded = (view: any) => {
	for (const v of view.capabilities)
		if (v.status !== "unverified") {
			v.limits.push({ code: "state-fingerprint-not-recorded", refs: [structuredClone(v.ref)] });
			v.limits.sort((m: { code: string }, n: { code: string }) => rank(m.code) - rank(n.code));
		}
};

// ---------------------------------------------------------------------------------------------------------------
// 1. A valid duplicate note establishes the kind of its earlier owner
// ---------------------------------------------------------------------------------------------------------------

describe("a duplicate note establishes the kind of the earlier owner of its id (P2)", () => {
	// fa is neither current (fc) nor the previous different observation (fb): no view presents it.
	const records = (extra: Record<string, unknown> = {}) => ({
		...base,
		fingerprint: [fa, fb, fc],
		evidence: evidenceMatching(fa),
		state: [{ ...first, fingerprintId: fa.id }],
		...extra,
	});
	const dupChange = changeRecord({ id: fa.id });

	it("Codex's snapshot: the first change repeats an unpresented older fingerprint, so a state naming it is recorded", () => {
		const s = snapshotOf(records({ change: [dupChange, c2] }));
		const identity = s.runtimes[0].identity;
		expect(identity.notes.some((n: { code: string }) => n.code === "duplicate-record-id")).toBe(true);
		expect([identity.current.id, identity.previousDifferent.id]).not.toContain(aliasOf(fa.id));
		const cap = s.runtimes[0].capabilities;
		expect(
			admittedAt(cap).every((i: number) => !codes(cap.capabilities[i]).includes("state-fingerprint-not-recorded")),
		).toBe(true);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const forged = mutated(s, (x) => withNotRecorded(x.runtimes[0].capabilities));
		// Nothing in the capability view alone proves the named fingerprint recorded; the identity's duplicate note does.
		expect(validateEndoCockpitCapabilityStateV0(forged.runtimes[0].capabilities)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});

	it("the identity view alone: a notice naming that id requires its missing-change note", () => {
		const i = identityOf(
			records({ change: [dupChange, c2, c3], notification: [notificationRecord({ changeId: fa.id })] }),
		);
		expect(i.notes.some((n) => n.code === "notification-change-missing")).toBe(true);
		expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
		const forged = mutated(i, (x) => {
			x.notes = x.notes.filter((n: { code: string }) => n.code !== "notification-change-missing");
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	it("the capability view alone: evidence repeating the only possible kind's id", () => {
		const evidence = evidenceMatching(fa).map((item, i) => (i === 0 ? { ...item, id: fa.id } : item));
		const p = capabilitiesOf(records({ evidence }));
		expect(p.notes.some((n) => n.code === "duplicate-record-id")).toBe(true);
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(mutated(p, withNotRecorded))).toBeNull();
	});

	it("withholds the inference when the candidates span kinds, and when a candidate kind is not cleaned", () => {
		// change index 2 repeats the first change's id: fingerprints and a change could own it.
		const own = changeRecord({ id: "endo.evidence.test-change.0" });
		const spanning = records({
			change: [own, c1, { ...changeRecord({ id: own.id }) }],
			state: [{ ...first, fingerprintId: own.id }],
		});
		const s = snapshotOf(spanning);
		expect(s.runtimes[0].identity.notes.some((n: { code: string }) => n.code === "duplicate-record-id")).toBe(true);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		// The capability view alone cannot clean changes: an evidence duplicate with changes recorded stays uncertain.
		const evidence = evidenceMatching(fa).map((item, i) => (i === 0 ? { ...item, id: fa.id } : item));
		const view = capabilitiesOf(records({ evidence, change: [c1] }));
		expect(validateEndoCockpitCapabilityStateV0(view)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(mutated(view, withNotRecorded))).not.toBeNull();
	});

	it("fires in a snapshot once every possible change is discarded, and agrees with a presented owner", () => {
		const evidence = evidenceMatching(fa).map((item, i) => (i === 0 ? { ...item, id: fa.id } : item));
		const s = snapshotOf(records({ evidence, change: [foreign(c1)] }));
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const forged = mutated(s, (x) => withNotRecorded(x.runtimes[0].capabilities));
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
		// The owner is `fb`, presented as the previous different observation: the inference agrees with the view.
		const presented = snapshotOf(
			records({
				evidence: evidenceMatching(fb).map((item, i) => (i === 0 ? { ...item, id: fb.id } : item)),
				state: [{ ...first, fingerprintId: fb.id }],
			}),
		);
		expect(validateEndoCockpitSnapshotV0(presented)).not.toBeNull();
	});

	it("withholds the inference while an unpresented change is kept: fingerprints and a change could own the id (snapshot)", () => {
		const evidence = evidenceMatching(fa).map((item, i) => (i === 0 ? { ...item, id: fa.id } : item));
		// Round 20: the one kept change of the earlier fixture was the PRESENTED last change, with another id, and so no owner;
		// the older change here is not presented, and its id is not known.
		const s = snapshotOf(records({ evidence, change: [c1, c2] }));
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const forged = mutated(s, (x) => withNotRecorded(x.runtimes[0].capabilities));
		expect(validateEndoCockpitSnapshotV0(forged)).not.toBeNull();
	});

	it("takes nothing from a foreign predecessor, and refuses a duplicate with no possible owner", () => {
		// A foreign fingerprint never enters the ledger: a change repeating its id is not a duplicate.
		const p = identityOf(records({ fingerprint: [foreign(fa), fb, fc], change: [dupChange, c2] }));
		expect(p.notes.some((n) => n.code === "duplicate-record-id")).toBe(false);
		const impossible = mutated(identityOf(records({ fingerprint: [foreign(fa), foreign(fb)] })), (x) => {
			x.notes.push({
				code: "duplicate-record-id",
				refs: [{ ...x.notes[0].refs[0], kind: "change", index: 0, id: aliasOf(fa.id) }],
			});
		});
		expect(validateEndoCockpitRuntimeIdentityV0(impossible)).toBeNull();
	});

	it("is not contradicted by a kept reference of another kind to the same id (the owner sits before the note)", () => {
		const s = snapshotOf(records({ change: [dupChange, c2, c3] }));
		const forged = mutated(s, (x) => {
			const identity = x.runtimes[0].identity;
			identity.notes.push({
				code: "runtime-disagreement",
				refs: [
					structuredClone(identity.current.ref),
					{ ...structuredClone(identity.current.ref), kind: "change", index: 1, id: aliasOf(fa.id) },
				],
			});
		});
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		// The contradiction is visible within the one view (a kept reference at an unpresented position is evidence too).
		expect(validateEndoCockpitRuntimeIdentityV0(forged.runtimes[0].identity)).toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});

	it("round-trips canonical defensive output with change duplicates of a kept fingerprint (soundness)", () => {
		let run = 0;
		for (const fingerprint of [
			[fa, fb, fc],
			[fa, foreign(fb), fc],
			[foreign(fa), fb, fc],
		])
			for (const change of [[dupChange], [dupChange, c2], [c1, dupChange, c2], [foreign(c1), dupChange, c2]])
				for (const named of [fa.id, fb.id, fc.id, c1.id])
					for (const evidenceRepeats of [false, true]) {
						const evidence = evidenceMatching(fa).map((item, i) =>
							evidenceRepeats && i === 0 ? { ...item, id: fb.id } : item,
						);
						const label = `${(fingerprint as unknown[]).length} fp / ${(change as unknown[]).length} ch / ${named.slice(-6)} / ${evidenceRepeats}`;
						try {
							expect(
								validateEndoCockpitSnapshotV0(
									snapshotOf({
										...records({ fingerprint, change, evidence }),
										state: [{ ...first, fingerprintId: named }],
									}),
								),
								label,
							).not.toBeNull();
							run += 1;
						} catch (error) {
							throw new Error(`${label}: ${(error as Error).message}`);
						}
					}
		expect(run).toBe(96);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The source-kind predicate enforces the kind grammar
// ---------------------------------------------------------------------------------------------------------------

describe("source-kind admission enforces the protocol's kind grammar (P2)", () => {
	const hex = "0123456789abcdef0123456789abcdef";

	it("admits well-formed kinds and refuses the rest, each for its own reason", () => {
		for (const ok of ["pi", "acp.v2", "a.b.c", "x-y.z0"])
			expect(isEndoCockpitSourceKindAdmittedV0(ok), ok).toBe(true);
		for (const bad of [
			"Not A Kind",
			"Pi",
			"a b",
			"a..b",
			"a.b!",
			"",
			"x".repeat(129),
			`a.withheld-${hex}`,
			"/home/alice/pi",
		])
			expect(isEndoCockpitSourceKindAdmittedV0(bad), bad).toBe(false);
		// Near misses keep their meaning.
		expect(isEndoCockpitSourceKindAdmittedV0("a.xwithheld-abc")).toBe(true);
		expect(isEndoCockpitSourceKindAdmittedV0("x".repeat(128))).toBe(true);
	});

	it("withholds a malformed lifecycle runtime instead of presenting it as observed", () => {
		const t = timelineOf(event("lifecycle.session-started", { runtime: "Not A Kind", instance: "i-1" }));
		expect(t.entries[0]!.fields.runtime).toMatchObject({ basis: "unavailable" });
		expect(validateEndoCockpitSessionTimelineV0(t)).not.toBeNull();
		const forged = mutated(
			timelineOf(event("lifecycle.session-started", { runtime: "pi", instance: "i-1" })),
			(x) => {
				x.entries[0].fields.runtime.value = "Not A Kind";
			},
		);
		expect(validateEndoCockpitSessionTimelineV0(forged)).toBeNull();
	});

	it("keeps ordinary and generated-alias kinds: an ordinary family is shown, a reserved one is withheld whole", () => {
		const ordinary = timelineOf(event("lifecycle.session-started", { runtime: "acp.v2", instance: "i-1" }));
		expect(ordinary.entries[0]!.fields.runtime).toEqual({ basis: "observed", value: "acp.v2" });
		const reserved = timelineOf(
			event("lifecycle.session-started", { runtime: `acp.withheld-${hex}`, instance: "i-1" }),
		);
		expect(reserved.entries[0]!.fields.runtime).toMatchObject({ basis: "unavailable" });
		const aliased = identityOf({ ...base, fingerprint: [{ ...base.fingerprint[0]!, runtime: `withheld-${hex}` }] });
		expect(validateEndoCockpitRuntimeIdentityV0(aliased)).not.toBeNull();
	});

	it("aliases an event kind outside the grammar that was previously presented raw (direct input only)", () => {
		// Before this round the predicate admitted "Not.A.Kind", the projector presented it as written, and the timeline
		// validator refused its own output (a TypeError). The durable store's envelope check keeps such a kind off the durable
		// path, so only direct projector input changes: it is now presented as its keyed alias.
		expect(timelineOf(event("Not.A.Kind", {})).entries[0]!.kind).toMatch(/^other\.withheld-[0-9a-f]{32}$/);
	});
});

describe("stored events outside the field contract are withheld on a source-backed read (P2)", () => {
	it("withholds a stored lifecycle runtime that is not a kind and a stored fingerprint reference of another namespace", () => {
		const root = tempRoot();
		ingestAll(root, [
			event("lifecycle.session-started", { runtime: "Not A Kind", instance: "i-1" }),
			event("harness.attached", {
				instance: "endo.session.test.one",
				fingerprintId: "endo.event.x.1",
				identityDigest: specimen().fingerprint.identity.digest,
				mapping: "pi-mapping-1",
			}),
		]);
		const before = treeHash(root);
		const read = readEndoCockpitTimelineV0(root);
		expect(read.entries).toHaveLength(2);
		expect(read.entries[0]!.fields.runtime).toMatchObject({ basis: "unavailable" });
		expect(read.entries[1]!.fields.fingerprintId).toMatchObject({ basis: "unavailable" });
		expect(validateEndoCockpitSessionTimelineV0(read)).not.toBeNull();
		expect(treeHash(root)).toBe(before);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. A fingerprint field is an evidence identifier
// ---------------------------------------------------------------------------------------------------------------

describe("fingerprint fields carry evidence identifiers (P2)", () => {
	const attached = (fingerprintId: unknown) =>
		timelineOf(
			event("harness.attached", {
				instance: "endo.session.test.one",
				fingerprintId,
				identityDigest: specimen().fingerprint.identity.digest,
				mapping: "pi-mapping-1",
			}),
		);
	const changed = (previous: unknown, current: unknown) =>
		timelineOf(event("harness.runtime-changed", { previousFingerprintId: previous, currentFingerprintId: current }));
	const ok = (t: unknown) => validateEndoCockpitSessionTimelineV0(t) !== null;
	const fieldOf = (t: EndoCockpitSessionTimelineV0, key: string) => t.entries[0]!.fields[key];

	it("presents an evidence id (aliased when content-addressed) and accepts the entry", () => {
		const t = attached(specimen().fingerprint.id);
		expect(fieldOf(t, "fingerprintId")).toMatchObject({
			basis: "observed",
			value: aliasOf(specimen().fingerprint.id),
		});
		expect(ok(t)).toBe(true);
		const plain = attached("endo.evidence.pi-fingerprint.1");
		expect(fieldOf(plain, "fingerprintId")).toEqual({ basis: "observed", value: "endo.evidence.pi-fingerprint.1" });
		const both = changed("endo.evidence.pi-fingerprint.1", "endo.evidence.pi-fingerprint.2");
		expect(ok(both)).toBe(true);
		expect(fieldOf(both, "previousFingerprintId")).toMatchObject({ basis: "observed" });
	});

	it("withholds an identifier of another namespace, keeping the namespace check on the source value", () => {
		for (const other of ["endo.event.not-a-fingerprint.1", "endo.session.test.one", "endo.run.test.1"]) {
			const t = attached(other);
			expect(fieldOf(t, "fingerprintId"), other).toMatchObject({ basis: "unavailable" });
			expect(ok(t), other).toBe(true);
			const c = changed(other, "endo.evidence.pi-fingerprint.2");
			expect(fieldOf(c, "previousFingerprintId"), other).toMatchObject({ basis: "unavailable" });
			expect(fieldOf(c, "currentFingerprintId")).toMatchObject({ basis: "observed" });
		}
		const current = changed("endo.evidence.pi-fingerprint.1", "endo.event.x.1");
		expect(fieldOf(current, "currentFingerprintId")).toMatchObject({ basis: "unavailable" });
	});

	it("omits a malformed identifier, and leaves other identifier fields generic", () => {
		expect(fieldOf(attached("not an id"), "fingerprintId")).toBeUndefined();
		expect(ok(attached("not an id"))).toBe(true);
		expect(fieldOf(attached(specimen().fingerprint.id), "instance")).toEqual({
			basis: "observed",
			value: "endo.session.test.one",
		});
	});

	it("refuses a wrong-namespace reference on the wire", () => {
		const good = attached(specimen().fingerprint.id);
		for (const wrong of ["endo.event.not-a-fingerprint.1", "endo.session.test.one"]) {
			const forged = mutated(good, (x) => {
				x.entries[0].fields.fingerprintId.value = wrong;
			});
			expect(ok(forged), wrong).toBe(false);
		}
		const forgedChange = mutated(changed("endo.evidence.pi-fingerprint.1", "endo.evidence.pi-fingerprint.2"), (x) => {
			x.entries[0].fields.previousFingerprintId.value = "endo.event.x.1";
		});
		expect(ok(forgedChange)).toBe(false);
	});
});
