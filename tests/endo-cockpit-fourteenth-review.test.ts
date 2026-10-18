// PR #57 review round 14: the withheld runtime session reference counted, both snapshot views agreeing on the fingerprint
// records set aside, an admitted capability carrying its fingerprint, and a disagreement citing distinct records.

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
import { ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0 } from "../protocol/cockpit-fields.ts";
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
	TEST_KEY,
} from "./cockpit-keyed.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const CLEAN = { state: "readable", tornTail: null, sealedAt: null, error: null } as const;
const mutated = <T>(value: T, edit: (copy: any) => void): T => {
	const copy = structuredClone(value);
	edit(copy);
	return copy;
};

/** A one-event log source whose watermark names that event, as the projection requires. */
const logSourceFor = (last: { id: string }) => ({
	domain: "event-log" as const,
	condition: { ...CLEAN },
	watermark: {
		length: 1,
		lastEventId: cockpitAliasesV0(TEST_KEY).id(last.id),
		prefixDigest: sha256HexV0("p"),
		keyId: TEST_KEY.keyId,
	},
});

function registryInput(records: ReturnType<typeof specimenRecords>) {
	const total = Object.values(records).reduce((sum, list) => sum + list.length, 0);
	const state = total === 0 ? ("empty" as const) : ("readable" as const);
	return {
		source: {
			domain: "harness-registry" as const,
			attachment: "pi.default",
			condition: { ...CLEAN, state: state },
			watermark: { ...registryWatermarkV0(TEST_KEY, state, records)!, keyId: TEST_KEY.keyId },
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

// ---------------------------------------------------------------------------------------------------------------
// 1. A withheld runtime session reference proves an omitted source key
// ---------------------------------------------------------------------------------------------------------------

describe("a withheld runtime session reference counts as withheld (P2)", () => {
	const UUID = "123e4567-e89b-12d3-a456-426614174000";
	const DIGEST = `sha256-${"a".repeat(48)}`;
	const ENDO = "endo-session-0123456789ab";
	const entryOf = (extra: Record<string, unknown>) => {
		const attached = event("harness.attached", {
			instance: "endo.session.test.one",
			fingerprintId: specimen().fingerprint.id,
			identityDigest: specimen().fingerprint.identity.digest,
			mapping: "pi-mapping-1",
			...extra,
		});
		const timeline = projectEndoCockpitSessionTimelineV0(
			{
				source: logSourceFor(attached),
				afterSequence: 0,
				events: stored([attached]),
			} as never,
			TEST_KEY,
		);
		return timeline;
	};
	const counted = (t: EndoCockpitSessionTimelineV0, n: number) =>
		mutated(t, (x) => {
			x.entries[0].withheldFields = n;
		});
	const ok = (t: EndoCockpitSessionTimelineV0) => validateEndoCockpitSessionTimelineV0(t) !== null;

	it("refuses a forged zero for a Pi, ACP v1 or ACP v2 reference the boundary withheld, accepts the projector's count", () => {
		for (const key of ["piSessionId", "acpSessionId"]) {
			const t = entryOf({ [key]: "/home/alice/session" });
			expect(t.entries[0]!.fields.runtimeSessionId).toMatchObject({ basis: "unavailable" });
			expect(t.entries[0]!.withheldFields).toBe(1);
			expect(ok(t), key).toBe(true);
			expect(ok(counted(t, 0)), key).toBe(false);
			expect(ok(counted(t, 2)), key).toBe(true);
		}
	});

	it("proves one key when both producers' keys are present (the wire cannot tell how many existed)", () => {
		const t = entryOf({ piSessionId: "/home/alice/s", acpSessionId: "/home/alice/s" });
		expect(t.entries[0]!.fields.runtimeSessionId).toMatchObject({ basis: "unavailable" });
		expect(t.entries[0]!.withheldFields).toBe(2);
		expect(ok(t)).toBe(true);
		expect(ok(counted(t, 1))).toBe(true);
		expect(ok(counted(t, 0))).toBe(false);
	});

	it("proves nothing for a safe reference, a missing one, or a conflict (the converse controls)", () => {
		for (const extra of [
			{ piSessionId: UUID },
			{ acpSessionId: DIGEST },
			{ acpSessionId: ENDO },
			{ piSessionId: UUID, acpSessionId: UUID },
			{},
		]) {
			const t = entryOf(extra);
			expect(t.entries[0]!.withheldFields).toBe(0);
			expect(ok(t), JSON.stringify(extra)).toBe(true);
		}
		const conflict = entryOf({ piSessionId: UUID, acpSessionId: DIGEST });
		expect(conflict.entries[0]!.fields.runtimeSessionId).toMatchObject({
			basis: "unavailable",
			reason: ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0,
		});
		// A conflict is two non-empty values under the two names, neither presented: it proves both omitted.
		expect(conflict.entries[0]!.withheldFields).toBe(2);
		expect(ok(counted(conflict, 0))).toBe(false);
		expect(ok(counted(conflict, 1))).toBe(false);
		expect(ok(counted(conflict, 2))).toBe(true);
		expect(ok(conflict)).toBe(true);
	});

	it("does not count a withheld reference twice with another carrier of the same key", () => {
		const t = entryOf({ piSessionId: "/home/alice/s", version: "/home/alice/v" });
		const own = t.entries[0]!.withheldFields;
		expect(ok(counted(t, own))).toBe(true);
		expect(ok(counted(t, own - 1))).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Both views of one snapshot attachment agree on the fingerprints set aside
// ---------------------------------------------------------------------------------------------------------------

describe("both snapshot views agree on the fingerprint records cleaned (P2)", () => {
	const fps = ["/a/pi", "/b/pi", "/c/pi", "/d/pi"].map(fingerprintAt);
	const foreign = (fp: (typeof fps)[number]) => ({ ...fp, attachment: "other.attachment" });
	const views = (list: unknown[]) => {
		const input = registryInput({ ...specimenRecords(), fingerprint: list } as never);
		return {
			identity: projectEndoCockpitRuntimeIdentityV0(input, TEST_KEY),
			capabilities: projectEndoCockpitCapabilityStateV0(input, TEST_KEY),
		};
	};
	const prompt = event("agent.prompt-accepted");
	const timeline = projectEndoCockpitSessionTimelineV0(
		{
			source: logSourceFor(prompt),
			afterSequence: 0,
			events: stored([prompt]),
		} as never,
		TEST_KEY,
	);
	const snapshot = (identity: unknown, capabilities: unknown) => ({
		schemaVersion: "endo.cockpit-snapshot.v0",
		projectionVersion: "cockpit-snapshot.3",
		consistency: "independent-sources",
		timeline,
		runtimes: [{ identity, capabilities }],
	});
	const accepted = (identity: unknown, capabilities: unknown) =>
		validateEndoCockpitSnapshotV0(snapshot(identity, capabilities)) !== null;
	const cleaning = (n: { notes: { code: string }[] }) =>
		n.notes.filter((note) => note.code === "foreign-attachment-record");

	it("accepts independently derived views of one read, whatever was discarded", () => {
		const [f0, f1, f2, f3] = fps as [any, any, any, any];
		const cases: [string, unknown[]][] = [
			["undisturbed", fps],
			["an earlier discarded", [foreign(f0), f1, f2, f3]],
			["the tail discarded", [f0, f1, f2, foreign(f3)]],
			["several discarded", [f0, foreign(f1), foreign(f2), foreign(f3)]],
			["all discarded", fps.map(foreign)],
			["none recorded", []],
		];
		for (const [name, list] of cases) {
			const { identity, capabilities } = views(list);
			expect(accepted(identity, capabilities), name).toBe(true);
		}
	});

	it("refuses Codex's snapshot: identity presents the tail, capability state discarded it", () => {
		const [f0, f1, f2, f3] = fps as [any, any, any, any];
		const kept = views(fps);
		const dropped = views([f0, f1, f2, foreign(f3)]);
		expect(dropped.capabilities.state!.latestFingerprintId).not.toBeNull();
		// The same source for both, as the watermark alone cannot tell the two reads apart.
		const forged = mutated(dropped.capabilities, (c) => {
			c.source = structuredClone(kept.identity.source);
		});
		expect(validateEndoCockpitCapabilityStateV0(forged)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(kept.identity)).not.toBeNull();
		expect(accepted(kept.identity, forged)).toBe(false);
		// ... and the reverse: identity discards the tail, capability state still names it.
		const reverse = mutated(kept.capabilities, (c) => {
			c.source = structuredClone(dropped.identity.source);
		});
		expect(accepted(dropped.identity, reverse)).toBe(false);
	});

	it("refuses a missing, extra or conflicting fingerprint cleaning note on either view", () => {
		const { identity, capabilities } = views([foreign(fps[0]!), fps[1], fps[2], fps[3]]);
		const [note] = cleaning(capabilities) as [{ code: string; refs: unknown[] }];
		expect(accepted(identity, capabilities)).toBe(true);
		const without = (v: any) =>
			mutated(v, (x) => {
				x.notes = x.notes.filter((n: any) => n.code !== note.code);
			});
		expect(accepted(identity, without(capabilities))).toBe(false);
		expect(accepted(without(identity), capabilities)).toBe(false);
		const extra = (v: any) =>
			mutated(v, (x) => {
				const ref = { ...(structuredClone(note.refs[0]) as any), index: 1, id: v.current?.ref.id ?? "x" };
				x.notes.push({ code: "foreign-attachment-record", refs: [ref] });
			});
		expect(accepted(identity, extra(capabilities))).toBe(false);
		const recoded = mutated(capabilities, (x) => {
			x.notes.find((n: any) => n.code === note.code).code = "duplicate-record-id";
		});
		expect(accepted(identity, recoded)).toBe(false);
		const recodedIdentity = mutated(identity, (x) => {
			x.notes.find((n: any) => n.code === note.code).code = "duplicate-record-id";
		});
		expect(accepted(recodedIdentity, capabilities)).toBe(false);
	});

	it("is not sensitive to the order of the notes, and ignores diagnostics about other kinds of record", () => {
		const { identity, capabilities } = views([foreign(fps[0]!), foreign(fps[1]!), fps[2], fps[3]]);
		expect(cleaning(identity)).toHaveLength(2);
		const reversed = mutated(capabilities, (x) => x.notes.reverse());
		expect(validateEndoCockpitCapabilityStateV0(reversed)).not.toBeNull();
		// The comparison is of the sets of dispositions, not of their order.
		expect(accepted(identity, reversed)).toBe(true);
		expect(cleaning(reversed)[0]).toEqual(cleaning(capabilities)[1]);
		// Evidence and state diagnostics belong to the capability view alone.
		const base = specimenRecords();
		const twoReusing = {
			...base,
			evidence: base.evidence.map((item, at) => (at < 2 ? { ...item, id: base.fingerprint[0]!.id } : item)),
		};
		const both = views([...twoReusing.fingerprint]);
		const input = registryInput(twoReusing as never);
		const capability = projectEndoCockpitCapabilityStateV0(input, TEST_KEY);
		const identityOf = projectEndoCockpitRuntimeIdentityV0(input, TEST_KEY);
		expect(capability.notes.some((n) => n.code === "duplicate-record-id")).toBe(true);
		expect(accepted(identityOf, capability)).toBe(true);
		expect(both.identity.notes).toEqual([]);
	});

	it("requires the state's latest fingerprint to be the identity's current one, without inventing a state", () => {
		const { identity, capabilities } = views(fps);
		expect(capabilities.state!.latestFingerprintId).toBe(identity.current!.id);
		const otherLatest = mutated(capabilities, (c) => {
			c.state.latestFingerprintId = fps[0]!.id;
			c.state.currency = c.state.fingerprintId === c.state.latestFingerprintId ? "current" : "stale";
		});
		expect(accepted(identity, otherLatest)).toBe(false);
		// The recorded (possibly historical) reference is a different thing and is not compared.
		const historical = mutated(capabilities, (c) => {
			c.state.fingerprintId = "endo.evidence.pi-fingerprint.historical";
			c.state.currency = "stale";
		});
		expect(accepted(identity, historical)).toBe(true);
		// A snapshot with no capability state is not asked for one.
		const empty = {
			identity: projectEndoCockpitRuntimeIdentityV0(
				registryInput({ ...specimenRecords(), fingerprint: [], state: [] } as never),
				TEST_KEY,
			),
			capabilities: projectEndoCockpitCapabilityStateV0(
				registryInput({ ...specimenRecords(), fingerprint: [], state: [] } as never),
				TEST_KEY,
			),
		};
		expect(empty.capabilities.state).toBeNull();
		expect(accepted(empty.identity, empty.capabilities)).toBe(true);
		const none = views(fps.map(foreign));
		expect(none.identity.current).toBeNull();
		expect(accepted(none.identity, none.capabilities)).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. An admitted capability carries a fingerprint
// ---------------------------------------------------------------------------------------------------------------

describe("an admitted capability requires the state's fingerprint (P2)", () => {
	const base = specimenRecords();
	const projectedFor = (state: unknown) =>
		projectEndoCockpitCapabilityStateV0(registryInput({ ...base, state: [state] } as never), TEST_KEY);
	const projected = projectedFor(base.state[0]);
	const noFingerprint = (p: any) => {
		p.state.fingerprintId = null;
		p.state.currency = "unknown";
	};

	it("refuses an admitted capability whose state has no fingerprint, though the currency is updated to match", () => {
		expect(projected.capabilities.some((c) => c.status !== "unverified")).toBe(true);
		expect(validateEndoCockpitCapabilityStateV0(projected)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(mutated(projected, noFingerprint))).toBeNull();
	});

	it("refuses the same in a mixed-status state, whose unverified member does not excuse the admitted one", () => {
		const first = base.state[0]!;
		const mixedState = {
			...first,
			capabilities: first.capabilities.map((c, at) =>
				at === 0 ? { ...c, status: "unverified", classification: null, evidenceId: null } : c,
			),
		};
		const mixed = projectedFor(mixedState);
		expect(mixed.capabilities.some((c) => c.status === "unverified")).toBe(true);
		expect(mixed.capabilities.some((c) => c.status !== "unverified")).toBe(true);
		expect(validateEndoCockpitCapabilityStateV0(mixed)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(mutated(mixed, noFingerprint))).toBeNull();
	});

	it("accepts the projector's output for a fingerprint-less unverified state and an absent state", () => {
		const unverified = {
			...base.state[0]!,
			fingerprintId: null,
			capabilities: base.state[0]!.capabilities.map((c) => ({
				...c,
				status: "unverified",
				classification: null,
				evidenceId: null,
			})),
		};
		const p = projectedFor(unverified);
		expect(p.state!.fingerprintId).toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		const absent = projectEndoCockpitCapabilityStateV0(registryInput({ ...base, state: [] } as never), TEST_KEY);
		expect(absent.state).toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(absent)).not.toBeNull();
	});

	it("does not demand the named fingerprint still be in the registry", () => {
		const orphan = projectedFor({ ...base.state[0]!, fingerprintId: "endo.evidence.pi-fingerprint.gone" });
		expect(validateEndoCockpitCapabilityStateV0(orphan)).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. A runtime disagreement cites distinct records
// ---------------------------------------------------------------------------------------------------------------

describe("a runtime-disagreement note cites distinct records (P2)", () => {
	const records = {
		...specimenRecords(),
		fingerprint: [fingerprintAt("/a/pi"), fingerprintAt("/b/pi")],
		change: [changeRecord()],
	};
	const identity = projectEndoCockpitRuntimeIdentityV0(registryInput(records as never), TEST_KEY);
	const withNote = (refs: unknown[]) =>
		mutated(identity, (i) => {
			i.notes.push({ code: "runtime-disagreement", refs: structuredClone(refs) });
		});
	const a = identity.current!.ref;
	const b = identity.previousDifferent!.ref;
	const c = identity.lastChange!.ref;

	it("accepts two or three distinct references, to fingerprints and/or changes", () => {
		for (const refs of [
			[a, b],
			[a, c],
			[b, c],
			[a, b, c],
		])
			expect(validateEndoCockpitRuntimeIdentityV0(withNote(refs)), String(refs.length)).not.toBeNull();
	});

	it("refuses one record cited twice, or a repeated member among three", () => {
		for (const refs of [
			[a, a],
			[c, c],
			[a, b, a],
			[a, a, b],
			[b, c, c],
		])
			expect(validateEndoCockpitRuntimeIdentityV0(withNote(refs))).toBeNull();
	});

	it("refuses one position cited twice under two ids", () => {
		const reid = { ...(b as any), id: (a as any).id };
		expect(validateEndoCockpitRuntimeIdentityV0(withNote([b, reid]))).toBeNull();
		expect(
			validateEndoCockpitRuntimeIdentityV0(withNote([b, { ...(b as any), id: "endo.evidence.other" }])),
		).toBeNull();
	});

	it("still refuses malformed or foreign references, and a single reference", () => {
		const foreignRef = { ...(a as any), attachment: "other.attachment" };
		const outside = { ...(b as any), index: 99 };
		expect(validateEndoCockpitRuntimeIdentityV0(withNote([a, foreignRef]))).toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withNote([a, outside]))).toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withNote([a]))).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Adjacent invariants: one position, one id; cross-kind id collisions still round-trip
// ---------------------------------------------------------------------------------------------------------------

describe("one position carries one id; legitimate collisions between kinds still validate", () => {
	const fps = [fingerprintAt("/a/pi"), fingerprintAt("/b/pi")];
	const timeline = (() => {
		const prompt = event("agent.prompt-accepted");
		return projectEndoCockpitSessionTimelineV0(
			{ source: logSourceFor(prompt), afterSequence: 0, events: stored([prompt]) } as never,
			TEST_KEY,
		);
	})();
	const snapshotOf = (records: unknown) => {
		const input = registryInput(records as never);
		return {
			schemaVersion: "endo.cockpit-snapshot.v0",
			projectionVersion: "cockpit-snapshot.3",
			consistency: "independent-sources",
			timeline,
			runtimes: [
				{
					identity: projectEndoCockpitRuntimeIdentityV0(input, TEST_KEY),
					capabilities: projectEndoCockpitCapabilityStateV0(input, TEST_KEY),
				},
			],
		};
	};

	it("round-trips a fingerprint whose id equals a change's or a notification's, tail or not", () => {
		for (const list of [fps, [fps[1]!, fps[0]!]]) {
			const tail = list.at(-1)!;
			// (The colliding record is not the last of its kind: a watermark ending two kinds at one id is refused on its own.)
			for (const colliding of [
				{ change: [changeRecord({ id: tail.id }), changeRecord({ id: "endo.evidence.test-change.2" })] },
				{ change: [changeRecord({ id: list[0]!.id }), changeRecord({ id: "endo.evidence.test-change.2" })] },
				{
					change: [changeRecord()],
					notification: [
						notificationRecord({ id: tail.id }),
						notificationRecord({ id: "endo.evidence.test-notification.2" }),
					],
				},
			]) {
				let snapshot: ReturnType<typeof snapshotOf>;
				try {
					snapshot = snapshotOf({ ...specimenRecords(), fingerprint: list, ...colliding });
				} catch (e) {
					throw new Error(
						`${list.indexOf(tail)} ${JSON.stringify(Object.keys(colliding))} ${(e as Error).message}`,
					);
				}
				expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
				const codes = (n: { notes: { code: string }[] }) => n.notes.map((note) => note.code);
				expect(codes(snapshot.runtimes[0]!.identity)).toContain("duplicate-record-id");
			}
		}
	});

	it("refuses a cleaning note giving the presented position another id, and a view naming a position under two ids", () => {
		const snapshot = snapshotOf({ ...specimenRecords(), fingerprint: fps });
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
		const previous = snapshot.runtimes[0]!.identity.previousDifferent!.ref as any;
		const forged = mutated(snapshot, (g) => {
			g.runtimes[0].identity.notes.push({
				code: "duplicate-record-id",
				refs: [{ ...previous, id: "endo.evidence.zzz" }],
			});
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forged.runtimes[0]!.identity)).toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
		const across = mutated(snapshot, (g) => {
			g.runtimes[0].capabilities.notes.push({
				code: "duplicate-record-id",
				refs: [{ ...previous, id: "endo.evidence.zzz" }],
			});
		});
		expect(validateEndoCockpitSnapshotV0(across)).toBeNull();
	});
});
