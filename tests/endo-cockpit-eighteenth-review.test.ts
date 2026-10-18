// PR #57 review round 18: a reference to a discarded position is no source, an id's kept owner decides what it can be (existence
// is not attributes), and a source-written name never impersonates a generated alias. Every negative is its own test.

import { mkdirSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cockpitAliasesV0, registryWatermarkV0 } from "../cockpit/projections/common.ts";
import {
	ENDO_COCKPIT_LIMIT_CODES_V0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import { endoHarnessIdentityBasisV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { endoHarnessRegistryDirectoryV0 } from "../storage/harness-registry.ts";
import {
	changeRecord,
	event,
	notificationRecord,
	removeTempRoots,
	specimen,
	specimenRecords,
	stored,
	tempRoot,
	treeHash,
} from "./cockpit-fixtures.ts";
import {
	checkEndoCockpitSourceFreshnessV0,
	listEndoCockpitAttachmentsV0,
	projectEndoCockpitCapabilityStateV0,
	projectEndoCockpitRuntimeIdentityV0,
	projectEndoCockpitSessionTimelineV0,
	readEndoCockpitRegistryV0,
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

function fingerprintAt(realPath: string, runtime = "pi", confidence?: "strong" | "reduced") {
	const base = specimen().fingerprint;
	const local = { ...base.local, realPath };
	const identity = {
		digest: sha256HexV0(
			canonicalEndoJsonV0(endoHarnessIdentityBasisV0({ runtime: "pi", local, reported: base.reported })),
		),
		confidence: confidence ?? base.identity.confidence,
	};
	const { id: _id, ...rest } = base;
	const body = { ...rest, local, identity, runtime };
	return { ...body, id: `endo.evidence.pi-fingerprint.${sha256HexV0(canonicalEndoJsonV0(body))}` };
}
const foreign = <T extends object>(item: T) => ({ ...item, attachment: "other.attachment" });
const [fa, fb, fc, fd] = ["/a/pi", "/b/pi", "/c/pi", "/d/pi"].map((path) => fingerprintAt(path)) as [
	ReturnType<typeof fingerprintAt>,
	ReturnType<typeof fingerprintAt>,
	ReturnType<typeof fingerprintAt>,
	ReturnType<typeof fingerprintAt>,
];
const identityOf = (records: unknown) => projectEndoCockpitRuntimeIdentityV0(registryInput(records as never), TEST_KEY);
const capabilitiesOf = (records: unknown) =>
	projectEndoCockpitCapabilityStateV0(registryInput(records as never), TEST_KEY);
const timeline = (() => {
	const one = event("agent.prompt-accepted");
	return projectEndoCockpitSessionTimelineV0(
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
	);
})();
const snapshotFrom = (identity: any, capabilities: any): any => ({
	schemaVersion: "endo.cockpit-snapshot.v0",
	projectionVersion: "cockpit-snapshot.3",
	consistency: "independent-sources",
	timeline,
	runtimes: [{ identity, capabilities }],
});
const snapshotOf = (records: unknown) => snapshotFrom(identityOf(records), capabilitiesOf(records));
const base = specimenRecords();
const first = base.state[0]!;
const codes = (v: { limits: { code: string }[] }) => v.limits.map((l) => l.code);
const admittedAt = (p: { capabilities: { status: string }[] }) =>
	p.capabilities.flatMap((c, at) => (c.status === "unverified" ? [] : [at]));
const ok = (p: unknown) => validateEndoCockpitCapabilityStateV0(p) !== null;
const evidenceWith = (dependencies: Record<string, unknown>, only?: string) =>
	base.evidence.map((item) =>
		only === undefined || item.id === only
			? { ...item, dependencies: { ...item.dependencies, ...dependencies } }
			: item,
	);
const at = (kind: string, index: number, id: string | null) => ({
	domain: "harness-registry",
	attachment: "pi.default",
	kind,
	index,
	id,
});

// ---------------------------------------------------------------------------------------------------------------
// 1. A discarded position is no source of a limit
// ---------------------------------------------------------------------------------------------------------------

describe("a capability limit cites no discarded fingerprint position (P2)", () => {
	const stateNaming = (id: string) => [{ ...first, fingerprintId: id }];
	/**
	 * The first admitted capability with one more limit citing `ref` as the fingerprint. "Not recorded" is first removed from
	 * every admitted capability (valid where several fingerprints are kept, since a historical one cannot be disproved), so
	 * that the rule about discarded positions, not the one about a named-but-unrecorded fingerprint, is what refuses it.
	 */
	const withLimit = (p: ReturnType<typeof capabilitiesOf>, code: string, ref: unknown, everyAdmitted = false) => {
		const bare = mutated(p, (x) => {
			for (const v of x.capabilities)
				v.limits = v.limits.filter((l: { code: string }) => l.code !== "state-fingerprint-not-recorded");
		});
		expect(ok(bare)).toBe(true);
		return mutated(bare, (x) => {
			for (const at of everyAdmitted ? admittedAt(p) : [admittedAt(p)[0]!]) {
				const view = x.capabilities[at];
				view.limits.push({
					code,
					refs: [
						structuredClone(view.ref),
						...(code === "runtime-differs" ? [] : [structuredClone(view.evidence.ref)]),
						ref,
					],
				});
				view.limits.sort((m: { code: string }, n: { code: string }) => rank(m.code) - rank(n.code));
			}
		});
	};

	it("accepts a limit citing a kept historical fingerprint that no view presents", () => {
		const records = {
			...base,
			fingerprint: [fa, foreign(fb), fc],
			evidence: evidenceWith({ identityDigest: "a".repeat(64) }),
			state: stateNaming(fa.id),
		};
		const p = capabilitiesOf(records);
		const limit = p.capabilities[admittedAt(p)[0]!]!.limits.find((l) => l.code === "evidence-identity-differs")!;
		expect(limit.refs[2]).toMatchObject({ kind: "fingerprint", index: 0 });
		expect(ok(p)).toBe(true);
	});

	it("refuses an evidence-*-differs limit citing a foreign-noted position", () => {
		const p = capabilitiesOf({ ...base, fingerprint: [fa, foreign(fb), fc], state: stateNaming(fb.id) });
		expect(p.notes.some((n) => n.code === "foreign-attachment-record")).toBe(true);
		expect(ok(p)).toBe(true);
		for (const code of ["evidence-identity-differs", "evidence-confidence-differs"])
			expect(ok(withLimit(p, code, at("fingerprint", 1, aliasOf(fb.id)))), code).toBe(false);
	});

	it("refuses a runtime-differs limit citing a discarded position", () => {
		const p = capabilitiesOf({ ...base, fingerprint: [fa, foreign(fb), fc], state: stateNaming(fb.id) });
		// The same limit citing the kept latest fingerprint is the projector's own shape; at the discarded position it is not.
		// (On every admitted capability: the fingerprint part of runtime-differs is the state's, so one alone is refused anyway.)
		expect(ok(withLimit(p, "runtime-differs", at("fingerprint", 1, aliasOf(fb.id)), true))).toBe(false);
	});

	it("refuses a limit citing a duplicate-noted position under the repeated id", () => {
		// (The evidence matches `fa`, so no kept limit cites its position 0: the repeated id at position 1 is then only a discard.)
		const p = capabilitiesOf({
			...base,
			fingerprint: [fa, { ...fa }, fc],
			evidence: evidenceWith({ identityDigest: fa.identity.digest }),
			state: stateNaming(fa.id),
		});
		expect(p.notes.some((n) => n.code === "duplicate-record-id")).toBe(true);
		expect(admittedAt(p).every((i) => !codes(p.capabilities[i]!).includes("state-fingerprint-not-recorded"))).toBe(
			true,
		);
		expect(ok(withLimit(p, "evidence-reduced-identity", at("fingerprint", 1, aliasOf(fa.id))))).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. A source-written name never impersonates a generated alias
// ---------------------------------------------------------------------------------------------------------------

describe("reserved attachment names are refused at the source boundary (P2)", () => {
	const hex = "0123456789abcdef0123456789abcdef";
	const reserved = [`withheld-${hex}`, `pi.withheld-${hex}.default`, `pi.withheld-${hex}`];
	const ordinary = ["pi.default", "pi.xwithheld-abc", "pi.withheldx", "withheld.pi", "pi.withheld"];

	function rootWith(names: string[]) {
		const root = tempRoot();
		for (const name of names) mkdirSync(endoHarnessRegistryDirectoryV0(root, name), { recursive: true });
		return root;
	}

	it("omits reserved names from discovery and keeps ordinary and near-miss names", () => {
		const root = rootWith([...reserved, ...ordinary]);
		mkdirSync(`${root}/harness/Not..Valid`, { recursive: true });
		const before = treeHash(root);
		expect(listEndoCockpitAttachmentsV0(root)).toEqual([...ordinary].sort());
		expect(treeHash(root)).toBe(before);
	});

	it("refuses an explicit read of a reserved name before touching the filesystem", () => {
		const root = rootWith(reserved);
		const before = treeHash(root);
		for (const name of reserved) expect(() => readEndoCockpitRegistryV0(root, name), name).toThrow(TypeError);
		expect(treeHash(root)).toBe(before);
	});

	it("still reads ordinary names, near misses and an absent attachment", () => {
		const root = rootWith(["pi.xwithheld-abc", "pi.withheldx"]);
		for (const name of ["pi.xwithheld-abc", "pi.withheldx", "pi.default"])
			expect(readEndoCockpitRegistryV0(root, name).source.attachment, name).toBe(name);
		expect(readEndoCockpitRegistryV0(root, "pi.default").source.condition.state).toBe("absent");
	});

	it("refuses a direct projector input and a wire source carrying a reserved attachment", () => {
		const input = registryInput(base) as any;
		const reservedInput = { ...input, source: { ...input.source, attachment: reserved[1] } };
		expect(() => projectEndoCockpitRuntimeIdentityV0(reservedInput, TEST_KEY)).toThrow(TypeError);
		expect(() => projectEndoCockpitCapabilityStateV0(reservedInput, TEST_KEY)).toThrow(TypeError);
		const identity = identityOf(base);
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		const forged = mutated(identity, (x) => {
			x.source.attachment = reserved[1];
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	it("refuses a reserved attachment on the wire alone, where a source has no references to fail first", () => {
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
		for (const project of [projectEndoCockpitRuntimeIdentityV0, projectEndoCockpitCapabilityStateV0] as const) {
			const projected = project(unopenable, TEST_KEY) as any;
			expect(projected.notes.map((n: { code: string }) => n.code)).toEqual(["source-not-projectable"]);
			const validate =
				project === projectEndoCockpitRuntimeIdentityV0
					? validateEndoCockpitRuntimeIdentityV0
					: validateEndoCockpitCapabilityStateV0;
			expect(validate(projected)).not.toBeNull();
			const forged = mutated(projected, (x) => {
				x.source.attachment = reserved[2];
			});
			expect(validate(forged)).toBeNull();
		}
	});

	it("gives a held reserved source the outcome an unsafe name has today: the freshness read refuses it", () => {
		const root = rootWith([]);
		const held = readEndoCockpitRegistryV0(root, "pi.default").source;
		const reservedHeld = { ...held, attachment: reserved[2]! };
		expect(() => checkEndoCockpitSourceFreshnessV0(root, reservedHeld as never)).toThrow(TypeError);
	});

	it("leaves generated aliases elsewhere valid: a reserved runtime family is aliased, not refused", () => {
		const aliased = identityOf({ ...base, fingerprint: [{ ...base.fingerprint[0]!, runtime: `withheld-${hex}` }] });
		expect(aliased.runtime).toMatchObject({ basis: "observed" });
		expect(validateEndoCockpitRuntimeIdentityV0(aliased)).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. A kept reference establishes existence; reduced evidence on a carried identity is then decided
// ---------------------------------------------------------------------------------------------------------------

describe("reduced-identity for a recorded historical fingerprint (P2)", () => {
	const OTHER = "endo.evidence.pi-fingerprint.other";
	/** A stale state naming the older kept `fa`; every evidence record is carried (names another fingerprint) and reduced. */
	const stale = (confidence: "reduced" | "strong", carriedFrom: string = OTHER, fps: unknown[] = [fa, fb, fc, fd]) =>
		capabilitiesOf({
			...base,
			fingerprint: fps,
			evidence: evidenceWith({ confidence, fingerprintId: carriedFrom }),
			state: [{ ...first, fingerprintId: fa.id }],
		});
	const without = (p: ReturnType<typeof capabilitiesOf>, which: number[], code: string) =>
		mutated(p, (x) => {
			for (const i of which)
				x.capabilities[i].limits = x.capabilities[i].limits.filter((l: { code: string }) => l.code !== code);
		});

	it("requires evidence-reduced-identity when another limit cites the named fingerprint (Codex's case)", () => {
		const p = stale("reduced");
		const target = admittedAt(p)[0]!;
		expect(codes(p.capabilities[target]!)).toContain("evidence-reduced-identity");
		expect(codes(p.capabilities[target]!)).toContain("evidence-confidence-differs");
		expect(ok(p)).toBe(true);
		expect(ok(without(p, [target], "evidence-reduced-identity"))).toBe(false);
	});

	it("decides existence for the whole state, not per capability", () => {
		const p = stale("reduced");
		const [one, two] = admittedAt(p) as [number, number];
		// `two` loses its reduced-identity limit and the only limits citing the named fingerprint with it; `one` still cites it.
		const forged = mutated(p, (x) => {
			x.capabilities[two].limits = x.capabilities[two].limits.filter(
				(l: { code: string }) =>
					!["evidence-reduced-identity", "evidence-confidence-differs", "evidence-identity-differs"].includes(
						l.code,
					),
			);
		});
		expect(codes(forged.capabilities[one]!)).toContain("evidence-confidence-differs");
		expect(ok(forged)).toBe(false);
	});

	it("keeps the uncertainty when no kept reference cites the named fingerprint", () => {
		const p = stale("reduced");
		const every = admittedAt(p);
		const bare = mutated(p, (x) => {
			for (const i of every)
				x.capabilities[i].limits = x.capabilities[i].limits.filter(
					(l: { code: string }) =>
						!["evidence-reduced-identity", "evidence-confidence-differs", "evidence-identity-differs"].includes(
							l.code,
						),
				);
		});
		expect(ok(bare)).toBe(true);
	});

	it("requires nothing for strong evidence, or for evidence that is not carried", () => {
		const strong = stale("strong");
		expect(
			admittedAt(strong).every((i) => !codes(strong.capabilities[i]!).includes("evidence-reduced-identity")),
		).toBe(true);
		expect(ok(strong)).toBe(true);
		const notCarried = stale("reduced", fa.id);
		expect(
			admittedAt(notCarried).every((i) => !codes(notCarried.capabilities[i]!).includes("evidence-reduced-identity")),
		).toBe(true);
		expect(ok(notCarried)).toBe(true);
	});

	it("adds no prohibition: with existence known and strong carried evidence, the limit stays permitted uniformly", () => {
		const strong = stale("strong");
		const every = admittedAt(strong);
		expect(every.every((i) => codes(strong.capabilities[i]!).includes("evidence-identity-differs"))).toBe(true);
		const added = mutated(strong, (x) => {
			for (const i of every) {
				const v = x.capabilities[i];
				const named = v.limits.find((l: { code: string }) => l.code === "evidence-identity-differs").refs[2];
				v.limits.push({
					code: "evidence-reduced-identity",
					refs: [structuredClone(v.ref), structuredClone(v.evidence.ref), structuredClone(named)],
				});
				v.limits.sort((m: { code: string }, n: { code: string }) => rank(m.code) - rank(n.code));
			}
		});
		expect(ok(strong)).toBe(true);
		expect(ok(added)).toBe(true);
	});

	it("never takes a discarded reference as proof of retention", () => {
		const p = capabilitiesOf({
			...base,
			fingerprint: [foreign(fa), fb, fc],
			evidence: evidenceWith({ confidence: "reduced", fingerprintId: OTHER }),
			state: [{ ...first, fingerprintId: fa.id }],
		});
		expect(admittedAt(p).every((i) => codes(p.capabilities[i]!).includes("state-fingerprint-not-recorded"))).toBe(
			true,
		);
		expect(admittedAt(p).every((i) => !codes(p.capabilities[i]!).includes("evidence-reduced-identity"))).toBe(true);
		expect(ok(p)).toBe(true);
	});

	it("still decides the latest fingerprint, and keeps the snapshot's embedded predicate", () => {
		const latest = capabilitiesOf({
			...base,
			fingerprint: [fa, fb],
			evidence: evidenceWith({ confidence: "reduced", fingerprintId: OTHER }),
			state: [{ ...first, fingerprintId: fb.id }],
		});
		const target = admittedAt(latest)[0]!;
		expect(ok(latest)).toBe(true);
		expect(ok(without(latest, [target], "evidence-reduced-identity"))).toBe(false);
	});

	it("applies across a snapshot: a disagreement reference proves the named fingerprint recorded", () => {
		// `fa` (runtime pi, confidence reduced, digest = the evidence's) is a family's representative, so the identity's
		// disagreement note cites it; the capability view alone has no limit citing it once its reduced limit is removed.
		const reduced = fingerprintAt("/a/pi", "pi", "reduced");
		const records = {
			...base,
			fingerprint: [reduced, fingerprintAt("/b/pi", "other"), fingerprintAt("/c/pi", "other")],
			evidence: evidenceWith({
				confidence: "reduced",
				identityDigest: reduced.identity.digest,
				fingerprintId: OTHER,
			}),
			state: [{ ...first, fingerprintId: reduced.id }],
		};
		const s = snapshotOf(records);
		const cap = s.runtimes[0]!.capabilities;
		const target = admittedAt(cap)[0]!;
		expect(codes(cap.capabilities[target]!)).toContain("evidence-reduced-identity");
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const note = s.runtimes[0]!.identity.notes.find((n: { code: string }) => n.code === "runtime-disagreement")!;
		expect(note.refs.some((r: unknown) => (r as { id: string }).id === aliasOf(reduced.id))).toBe(true);
		// (Removed from every admitted capability: one left standing would itself cite the named fingerprint.)
		const forged = mutated(s, (x) => {
			for (const v of x.runtimes[0].capabilities.capabilities)
				v.limits = v.limits.filter((l: { code: string }) => l.code !== "evidence-reduced-identity");
		});
		// The capability view alone cannot tell the named fingerprint is recorded; the snapshot's identity view can.
		expect(validateEndoCockpitCapabilityStateV0(forged.runtimes[0]!.capabilities)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4 and 5. Cross-kind ownership through a disagreement reference
// ---------------------------------------------------------------------------------------------------------------

describe("a kept record cited in a runtime-disagreement note owns its id (P2)", () => {
	const c1 = changeRecord({ id: "endo.evidence.test-change.1" });
	const c2 = changeRecord({ id: "endo.evidence.test-change.2" });
	const notice = (changeId: string) => notificationRecord({ changeId });
	const missing = (i: { notes: { code: string }[] }) =>
		i.notes.filter((n) => n.code === "notification-change-missing");
	const withoutNote = <T extends { notes: { code: string }[] }>(value: T) =>
		mutated(value, (x) => {
			x.notes = x.notes.filter((n: { code: string }) => n.code !== "notification-change-missing");
		});

	// fa (runtime pi) is the representative of its family at index 0; fb, fc are "other": the note cites fa and the current fc,
	// and fa is neither current nor the previous different observation (that is fb).
	const fps = [fa, fingerprintAt("/b/pi", "other"), fingerprintAt("/c/pi", "other")];
	const otherChange = changeRecord({ id: "endo.evidence.test-change.1", runtime: "other" } as never);

	it("finding 4: requires the missing-change note for a fingerprint id seen only in the disagreement", () => {
		const i = identityOf({ ...base, fingerprint: fps, change: [c1, c2], notification: [notice(fa.id)] });
		const note = i.notes.find((n) => n.code === "runtime-disagreement")!;
		expect(note.refs.some((r: unknown) => (r as { id: string }).id === aliasOf(fa.id))).toBe(true);
		expect([i.current!.id, i.previousDifferent!.id]).not.toContain(aliasOf(fa.id));
		expect(missing(i)).toHaveLength(1);
		expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withoutNote(i))).toBeNull();
	});

	it("finding 4: keeps the note optional for an unowned historical id, and refuses it for a kept change's id", () => {
		const unowned = identityOf({
			...base,
			fingerprint: fps,
			change: [c1, c2],
			notification: [notice("endo.evidence.test-change.9")],
		});
		expect(validateEndoCockpitRuntimeIdentityV0(withoutNote(unowned))).not.toBeNull();
		// (A kept change is an owner once a kept reference cites it: here the disagreement cites the first change.)
		const keptChange = identityOf({
			...base,
			fingerprint: [fa, fb, fc],
			change: [otherChange, c2],
			notification: [notice(otherChange.id)],
		});
		expect(missing(keptChange)).toHaveLength(0);
		expect(validateEndoCockpitRuntimeIdentityV0(keptChange)).not.toBeNull();
		const forged = mutated(keptChange, (x) => {
			x.notes.push({ code: "notification-change-missing", refs: [structuredClone(x.lastNotification.ref)] });
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	it("finding 4: a discarded fingerprint owns nothing", () => {
		const i = identityOf({
			...base,
			fingerprint: [foreign(fa), ...fps.slice(1)],
			change: [c1, c2],
			notification: [notice(fa.id)],
		});
		expect(missing(i)).toHaveLength(1);
		expect(validateEndoCockpitRuntimeIdentityV0(withoutNote(i))).not.toBeNull();
	});

	// Changes: c1 (runtime "other") then c2; fingerprints all pi. The note cites the current fingerprint and the change c1,
	// which is not the last change (c2).
	const changeRecords = [otherChange, c2];
	const stateNaming = (id: string) => [{ ...first, fingerprintId: id }];

	it("finding 5: requires 'not recorded' everywhere for a state naming a change seen only in the disagreement", () => {
		const records = { ...base, fingerprint: [fa, fb, fc], change: changeRecords, state: stateNaming(otherChange.id) };
		const s = snapshotOf(records);
		const note = s.runtimes[0]!.identity.notes.find((n: { code: string }) => n.code === "runtime-disagreement")!;
		expect(note.refs.some((r: unknown) => (r as { kind: string }).kind === "change")).toBe(true);
		expect(s.runtimes[0]!.identity.lastChange!.id).toBe(aliasOf(c2.id));
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		const forged = mutated(s, (x) => {
			for (const v of x.runtimes[0].capabilities.capabilities)
				v.limits = v.limits.filter((l: { code: string }) => l.code !== "state-fingerprint-not-recorded");
		});
		// Three kept fingerprints, two embedded: the capability view alone cannot tell; the identity's reference can.
		expect(validateEndoCockpitCapabilityStateV0(forged.runtimes[0]!.capabilities)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});

	it("finding 5: still requires uniformity, and keeps a historical fingerprint's uncertainty", () => {
		const records = { ...base, fingerprint: [fa, fb, fc], change: changeRecords, state: stateNaming(otherChange.id) };
		const s = snapshotOf(records);
		const one = mutated(s, (x) => {
			const v = x.runtimes[0].capabilities.capabilities[admittedAt(x.runtimes[0].capabilities)[0]!];
			v.limits = v.limits.filter((l: { code: string }) => l.code !== "state-fingerprint-not-recorded");
		});
		expect(validateEndoCockpitSnapshotV0(one)).toBeNull();
		const historical = snapshotOf({ ...records, state: stateNaming("endo.evidence.pi-fingerprint.historical") });
		const dropped = mutated(historical, (x) => {
			for (const v of x.runtimes[0].capabilities.capabilities)
				v.limits = v.limits.filter((l: { code: string }) => l.code !== "state-fingerprint-not-recorded");
		});
		expect(validateEndoCockpitSnapshotV0(historical)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(dropped)).not.toBeNull();
	});

	it("finding 5: a discarded change owns nothing, and unverified entries are not asked", () => {
		const records = {
			...base,
			fingerprint: [fa, fb, fc],
			change: [foreign(otherChange), c2],
			state: stateNaming(otherChange.id),
		};
		const s = snapshotOf(records);
		const dropped = mutated(s, (x) => {
			for (const v of x.runtimes[0].capabilities.capabilities)
				v.limits = v.limits.filter((l: { code: string }) => l.code !== "state-fingerprint-not-recorded");
		});
		expect(validateEndoCockpitSnapshotV0(dropped)).not.toBeNull();
		const unverified = snapshotOf({
			...base,
			fingerprint: [fa, fb, fc],
			change: changeRecords,
			state: [
				{
					...first,
					fingerprintId: otherChange.id,
					capabilities: first.capabilities.map((c) => ({
						...c,
						status: "unverified",
						classification: null,
						evidenceId: null,
					})),
				},
			],
		});
		expect(validateEndoCockpitSnapshotV0(unverified)).not.toBeNull();
	});
});

describe("a cleaning note's id is no ownership evidence (soundness)", () => {
	const both = (records: unknown) => {
		const s = snapshotOf(records);
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		return s;
	};

	it("evidence repeating a kept fingerprint's id does not make evidence the owner of a state's fingerprint", () => {
		const records = {
			...base,
			fingerprint: [fa, fb, fc],
			evidence: base.evidence.map((item, i) => (i === 0 ? { ...item, id: fa.id } : item)),
			state: [{ ...first, fingerprintId: fa.id }],
		};
		const s = both(records);
		const cap = s.runtimes[0]!.capabilities;
		expect(cap.notes.some((n: { code: string }) => n.code === "duplicate-record-id")).toBe(true);
		expect(
			admittedAt(cap).every((i: number) => !codes(cap.capabilities[i]!).includes("state-fingerprint-not-recorded")),
		).toBe(true);
		expect(cap.state!.fingerprintId).toBe(aliasOf(fa.id));
	});

	it("a foreign record's id may equal a kept record's without making the foreign kind the owner", () => {
		const keptTwin = { ...fa, attachment: "pi.default" };
		const records = {
			...base,
			fingerprint: [foreign(fa), keptTwin, fc],
			state: [{ ...first, fingerprintId: fa.id }],
		};
		const s = both(records);
		const cap = s.runtimes[0]!.capabilities;
		expect(cap.notes.some((n: { code: string }) => n.code === "foreign-attachment-record")).toBe(true);
		expect(
			admittedAt(cap).every((i: number) => !codes(cap.capabilities[i]!).includes("state-fingerprint-not-recorded")),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Soundness: canonical output over the modes this round adds
// ---------------------------------------------------------------------------------------------------------------

describe("projector output over kept-historical-fingerprint modes validates (soundness)", () => {
	it("accepts them in both views and the snapshot", () => {
		const other = fingerprintAt("/a/pi", "other");
		let run = 0;
		for (const fingerprint of [
			[fa, fb, fc],
			[other, fb, fc],
			[fa, foreign(fb), fc, fd],
			[fa, { ...fa }, fc],
		])
			for (const confidence of ["strong", "reduced"] as const)
				for (const carried of [true, false])
					for (const named of ["older", "latest", "foreign", "evidence-id"] as const) {
						const kept = (fingerprint as { id: string; attachment: string }[]).filter(
							(f) => f.attachment === "pi.default",
						);
						const fingerprintId =
							named === "older"
								? kept[0]!.id
								: named === "latest"
									? kept.at(-1)!.id
									: named === "foreign"
										? (fingerprint as { id: string }[]).find((f, i) => i === 1)!.id
										: base.evidence[0]!.id;
						for (const repeats of [false, true]) {
							const evidence = evidenceWith({
								confidence,
								...(carried ? { fingerprintId: "endo.evidence.pi-fingerprint.other" } : {}),
							});
							const records = {
								...base,
								fingerprint,
								// evidence[0] repeating a kept fingerprint's id: a cleaning note carrying that fingerprint's id.
								evidence: repeats
									? evidence.map((item, i) => (i === 0 ? { ...item, id: kept[0]!.id } : item))
									: evidence,
								state: [{ ...first, fingerprintId }],
							};
							const label = `${(fingerprint as unknown[]).length} fp / ${confidence} / ${carried} / ${named} / ${repeats}`;
							try {
								expect(validateEndoCockpitSnapshotV0(snapshotOf(records)), label).not.toBeNull();
								run += 1;
							} catch (error) {
								throw new Error(`${label}: ${(error as Error).message}`);
							}
						}
					}
		expect(run).toBe(128);
	});
});
