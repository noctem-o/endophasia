// PR #57 review round 15: malformed message usage counted, singleton histories requiring their note and limit, the whole
// registry input bound to its watermark, evidence limits reconciled with the embedded fingerprint, and two impossible
// diagnostics refused.

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
import { endoHarnessIdentityBasisV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { deepFreezeCopyV0 } from "../runtime/contracts/immutability.ts";
import {
	changeRecord,
	event,
	notificationRecord,
	removeTempRoots,
	seedRegistry,
	specimen,
	specimenRecords,
	stored,
	tempRoot,
	treeHash,
} from "./cockpit-fixtures.ts";
import {
	OTHER_KEY,
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

/** A registry input whose source is what the reader would advertise for these records (the same construction). */
function registryInput(records: ReturnType<typeof specimenRecords>, key = TEST_KEY) {
	const total = Object.values(records).reduce((sum, list) => sum + list.length, 0);
	const state = total === 0 ? ("empty" as const) : ("readable" as const);
	return {
		source: {
			domain: "harness-registry" as const,
			attachment: "pi.default",
			condition: { ...CLEAN, state },
			watermark: registryWatermarkV0(key, state, records),
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
const aliasOf = (id: string) => cockpitAliasesV0(TEST_KEY).id(id);
const identityOf = (records: unknown) => projectEndoCockpitRuntimeIdentityV0(registryInput(records as never), TEST_KEY);
const capabilitiesOf = (records: unknown) =>
	projectEndoCockpitCapabilityStateV0(registryInput(records as never), TEST_KEY);

// ---------------------------------------------------------------------------------------------------------------
// 1. Malformed message usage proves its key
// ---------------------------------------------------------------------------------------------------------------

describe("malformed message usage counts as withheld (P2)", () => {
	const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7 };
	const withCount = (t: EndoCockpitSessionTimelineV0, n: number) =>
		mutated(t, (x) => {
			x.entries[0].withheldFields = n;
		});
	const ok = (t: EndoCockpitSessionTimelineV0) => validateEndoCockpitSessionTimelineV0(t) !== null;
	const timeline = (payload: Record<string, unknown>, kind = "message.completed") => {
		const one = event(kind, payload);
		return projectEndoCockpitSessionTimelineV0(
			{
				source: sourceFor(one),
				afterSequence: 0,
				events: stored([one]),
			} as never,
			TEST_KEY,
		);
	};
	function sourceFor(one: { id: string }) {
		return {
			domain: "event-log" as const,
			condition: { ...CLEAN },
			watermark: {
				length: 1,
				lastEventId: aliasOf(one.id),
				prefixDigest: sha256HexV0("p"),
				keyId: TEST_KEY.keyId,
			},
		};
	}

	it("refuses zero for an assistant message with a malformed usage, and accepts the projector's count", () => {
		const t = timeline({ role: "assistant", usage: { input: "x" } });
		expect(t.entries[0]!.usage).toMatchObject({ reason: "the recorded usage is not in the expected shape" });
		expect(t.entries[0]!.withheldFields).toBe(1);
		expect(ok(t)).toBe(true);
		expect(ok(withCount(t, 0))).toBe(false);
		// Not a usage object at all counts the same (the key existed).
		for (const bad of [null, "text", 7, []]) {
			const odd = timeline({ role: "assistant", usage: bad });
			expect(odd.entries[0]!.usage).toMatchObject({ reason: "the recorded usage is not in the expected shape" });
			expect(ok(withCount(odd, 0)), JSON.stringify(bad)).toBe(false);
		}
	});

	it("proves nothing for valid, missing, or user-message usage, and leaves entry observations to their carrier", () => {
		const valid = timeline({ role: "assistant", usage });
		expect(valid.entries[0]!.usage).toMatchObject({ basis: "reported" });
		expect(ok(withCount(valid, 0))).toBe(true);
		const missing = timeline({ role: "assistant" });
		expect(missing.entries[0]!.usage).toMatchObject({ reason: "the event records no usage" });
		expect(ok(withCount(missing, 0))).toBe(true);
		const user = timeline({ role: "user", usage: { input: "x" } });
		expect(user.entries[0]!.usage).toBeNull();
		expect(ok(withCount(user, 0))).toBe(true);
		const entry = timeline({ entryType: "usage", details: { usage: { input: "x" } } }, "session.entry-observed");
		expect(entry.entries[0]!.withheldFields).toBe(1); // the `details` carrier, once
		expect(ok(withCount(entry, 1))).toBe(true);
		expect(ok(withCount(entry, 0))).toBe(false);
	});

	it("counts the usage key once with other withheld keys, not twice", () => {
		// The usage key and a withheld runtime event are two distinct keys: the bound is exactly two.
		const t = timeline({ role: "assistant", usage: { input: "x" }, runtimeEvent: "/home/alice/e" });
		expect(t.entries[0]!.withheldFields).toBe(2);
		expect(ok(t)).toBe(true);
		expect(ok(withCount(t, 1))).toBe(false);
		expect(ok(withCount(t, 3))).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. A singleton retained change history requires the missing-change note
// ---------------------------------------------------------------------------------------------------------------

describe("a notice naming no kept change requires its note, for zero or one kept change (P2)", () => {
	const noteOf = (i: { notes: { code: string }[] }) => i.notes.filter((n) => n.code === "notification-change-missing");
	const without = <T extends { notes: { code: string }[] }>(i: T) =>
		mutated(i, (x) => {
			x.notes = x.notes.filter((n: { code: string }) => n.code !== "notification-change-missing");
		});
	const c1 = changeRecord({ id: "endo.evidence.test-change.1" });
	const c2 = changeRecord({ id: "endo.evidence.test-change.2" });
	const c3 = changeRecord({ id: "endo.evidence.test-change.3" });
	const notice = (changeId: string) => notificationRecord({ changeId });
	const identity = (change: unknown[], notification: unknown[]) =>
		identityOf({ ...specimenRecords(), change, notification });

	it("zero kept (none recorded, or all discarded): required, as before", () => {
		for (const change of [[], [foreign(c1)]]) {
			const i = identity(change, [notice(c1.id)]);
			expect(noteOf(i)).toHaveLength(1);
			expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
			expect(validateEndoCockpitRuntimeIdentityV0(without(i))).toBeNull();
		}
	});

	it("exactly one kept with another id: required, whichever position is discarded", () => {
		const cases: unknown[][] = [[c1], [foreign(c1), c2], [c1, foreign(c2)], [foreign(c1), c2, foreign(c3)]];
		for (const change of cases) {
			const i = identity(change, [notice(c3.id)]);
			expect(noteOf(i), JSON.stringify(change.length)).toHaveLength(1);
			expect(validateEndoCockpitRuntimeIdentityV0(i)).not.toBeNull();
			expect(validateEndoCockpitRuntimeIdentityV0(without(i))).toBeNull();
		}
		// The notice names a discarded change: still not among the kept one.
		const tail = identity([c1, foreign(c2)], [notice(c2.id)]);
		expect(noteOf(tail)).toHaveLength(1);
		expect(validateEndoCockpitRuntimeIdentityV0(without(tail))).toBeNull();
	});

	it("exactly one kept with the notice's id: no note, and none allowed", () => {
		const match = identity([c1], [notice(c1.id)]);
		expect(noteOf(match)).toHaveLength(0);
		expect(validateEndoCockpitRuntimeIdentityV0(match)).not.toBeNull();
		const kept = identity([foreign(c1), c2], [notice(c2.id)]);
		expect(noteOf(kept)).toHaveLength(0);
		expect(validateEndoCockpitRuntimeIdentityV0(kept)).not.toBeNull();
		const forged = mutated(match, (i) => {
			i.notes.push({ code: "notification-change-missing", refs: [structuredClone(i.lastNotification.ref)] });
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	it("several kept: whether the notice's change is among them is undecidable, so the note stays optional", () => {
		const i = identity([c1, c2], [notice(c3.id)]);
		expect(noteOf(i)).toHaveLength(1);
		expect(validateEndoCockpitRuntimeIdentityV0(without(i))).not.toBeNull();
		const earlier = identity([c1, c2], [notice(c1.id)]);
		expect(noteOf(earlier)).toHaveLength(0);
		expect(validateEndoCockpitRuntimeIdentityV0(earlier)).not.toBeNull();
		const twoOfThree = identity([c1, foreign(c2), c3], [notice(c1.id)]);
		expect(validateEndoCockpitRuntimeIdentityV0(twoOfThree)).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. A singleton retained fingerprint history requires the unrecorded-fingerprint limit
// ---------------------------------------------------------------------------------------------------------------

describe("a state naming an unkept fingerprint requires its limit, for zero or one kept (P2)", () => {
	const base = specimenRecords();
	const named = base.fingerprint[0]!;
	const [a, b, c] = [fingerprintAt("/a/pi"), fingerprintAt("/b/pi"), fingerprintAt("/c/pi")] as const;
	const admittedAt = (p: ReturnType<typeof capabilitiesOf>) =>
		p.capabilities.findIndex((v) => v.status !== "unverified");
	const codes = (v: { limits: { code: string }[] }) => v.limits.map((l) => l.code);
	const dropped = (p: ReturnType<typeof capabilitiesOf>) =>
		mutated(p, (x) => {
			for (const view of x.capabilities)
				view.limits = view.limits.filter((l: { code: string }) => l.code !== "state-fingerprint-not-recorded");
		});
	const project = (fingerprint: unknown[]) => capabilitiesOf({ ...base, fingerprint });

	it("zero kept (none recorded, or all discarded): required", () => {
		for (const list of [[], [foreign(a)], [foreign(a), foreign(b)]]) {
			const p = project(list);
			expect(codes(p.capabilities[admittedAt(p)]!)).toContain("state-fingerprint-not-recorded");
			expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
			expect(validateEndoCockpitCapabilityStateV0(dropped(p))).toBeNull();
		}
	});

	it("exactly one kept, not the named one: required, whichever positions were discarded", () => {
		for (const list of [[a], [foreign(a), b], [a, foreign(b)], [foreign(a), b, foreign(c)]]) {
			const p = project(list);
			expect(codes(p.capabilities[admittedAt(p)]!)).toContain("state-fingerprint-not-recorded");
			expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
			expect(validateEndoCockpitCapabilityStateV0(dropped(p))).toBeNull();
		}
	});

	it("exactly one kept and it is the named one: no limit, and none allowed", () => {
		for (const list of [[named], [foreign(a), named], [named, foreign(a)]]) {
			const p = project(list);
			expect(codes(p.capabilities[admittedAt(p)]!)).not.toContain("state-fingerprint-not-recorded");
			expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		}
	});

	it("several kept: an older kept record may be the named one, so the limit stays optional", () => {
		for (const list of [
			[a, b],
			[a, b, foreign(c)],
			[foreign(a), b, c],
		]) {
			const p = project(list);
			expect(codes(p.capabilities[admittedAt(p)]!)).toContain("state-fingerprint-not-recorded");
			expect(validateEndoCockpitCapabilityStateV0(dropped(p))).not.toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. The whole registry input is bound to its watermark
// ---------------------------------------------------------------------------------------------------------------

describe("a registry input must be the records its source advertises (P2)", () => {
	const records = () => ({
		...specimenRecords(),
		change: [changeRecord()],
		notification: [notificationRecord()],
	});
	const projectors = {
		identity: (input: never, key = TEST_KEY) => projectEndoCockpitRuntimeIdentityV0(input, key),
		capabilities: (input: never, key = TEST_KEY) => projectEndoCockpitCapabilityStateV0(input, key),
	};
	const both = (input: unknown, key = TEST_KEY) => ({
		identity: () => projectors.identity(input as never, key),
		capabilities: () => projectors.capabilities(input as never, key),
	});

	it("accepts a reader-backed input in both projectors, writing nothing", () => {
		const root = tempRoot();
		seedRegistry(root);
		const before = treeHash(root);
		const read = readEndoCockpitRegistryV0(root, "pi.default");
		expect(read.records).not.toBeNull();
		const frozen = deepFreezeCopyV0(read);
		expect(() => projectors.identity(frozen as never)).not.toThrow();
		expect(() => projectors.capabilities(frozen as never)).not.toThrow();
		expect(treeHash(root)).toBe(before);
		// ... and the fixtures' construction is the reader's: byte-identical sources.
		const rebuilt = registryInput(read.records as never);
		expect(canonicalEndoJsonV0((rebuilt as { source: unknown }).source)).toBe(canonicalEndoJsonV0(read.source));
	});

	it("accepts consistent in-memory input in both projectors, without modifying it", () => {
		const input = deepFreezeCopyV0(registryInput(records() as never) as unknown as object);
		const run = both(input);
		expect(canonicalEndoJsonV0(run.identity())).toBe(canonicalEndoJsonV0(run.identity()));
		expect(() => run.capabilities()).not.toThrow();
		const emptyInput = deepFreezeCopyV0(
			registryInput({
				fingerprint: [],
				change: [],
				evidence: [],
				state: [],
				notification: [],
			} as never) as unknown as object,
		);
		expect(() => projectors.identity(emptyInput as never)).not.toThrow();
		expect(() => projectors.capabilities(emptyInput as never)).not.toThrow();
	});

	const refused = (input: unknown, message?: string) => {
		const run = both(input);
		for (const name of ["identity", "capabilities"] as const)
			expect.soft(() => run[name](), name).toThrow(message === undefined ? TypeError : new RegExp(message));
	};
	const edit = (fn: (copy: any) => void) => mutated(registryInput(records() as never) as any, fn);

	it("refuses a count altered for a kind the projection does not present", () => {
		refused(
			edit((i) => {
				i.source.watermark.counts.evidence += 1;
			}),
		);
		refused(
			edit((i) => {
				i.source.watermark.counts.change += 1;
			}),
		);
		refused(
			edit((i) => {
				i.source.watermark.counts.notification -= 1;
			}),
		);
	});

	it("refuses a tail id altered for an otherwise unused kind", () => {
		refused(
			edit((i) => {
				i.source.watermark.lastIds.evidence = "endo.evidence.forged";
			}),
		);
		refused(
			edit((i) => {
				i.source.watermark.lastIds.state = "endo.evidence.forged";
			}),
		);
		refused(
			edit((i) => {
				i.source.watermark.lastIds.change = null;
			}),
		);
	});

	it("refuses record content altered without its digest, in any kind", () => {
		for (const kind of ["fingerprint", "change", "evidence", "state", "notification"] as const) {
			const input = registryInput(records() as never) as any;
			const altered = structuredClone(input.records);
			(altered[kind][0] as any).note = "altered";
			refused({ ...input, records: altered });
		}
	});

	it("refuses a digest of the wrong kind, a plain hash, or another key's", () => {
		const input = registryInput(records() as never) as any;
		const plain = sha256HexV0(canonicalEndoJsonV0(input.records));
		refused(
			edit((i) => {
				i.source.watermark.contentDigest = plain;
			}),
		);
		// Made under another key but claiming this key's id.
		const other = registryInput(records() as never, OTHER_KEY) as any;
		refused({
			...input,
			source: { ...input.source, watermark: { ...other.source.watermark, keyId: TEST_KEY.keyId } },
		});
		// ... and the key the caller projects with is not the key the source was read under.
		const run = both(input, OTHER_KEY);
		expect(() => run.identity()).toThrow(TypeError);
		expect(() => run.capabilities()).toThrow(TypeError);
	});

	it("still cleans coherent defensive input: foreign and repeated records are noted, not refused", () => {
		const base = specimenRecords();
		const list = {
			...base,
			fingerprint: [fingerprintAt("/a/pi"), foreign(fingerprintAt("/b/pi"))],
			evidence: base.evidence.map((item, at) => (at === 1 ? { ...item, id: base.evidence[0]!.id } : item)),
		};
		const input = registryInput(list as never);
		const identity = projectors.identity(input as never);
		const capabilities = projectors.capabilities(input as never);
		expect(identity.notes.map((n) => n.code)).toContain("foreign-attachment-record");
		expect(capabilities.notes.map((n) => n.code)).toEqual(
			expect.arrayContaining(["foreign-attachment-record", "duplicate-record-id"]),
		);
	});

	it("keeps the documented empty, absent, degraded and unopenable semantics", () => {
		const empty = registryInput({ fingerprint: [], change: [], evidence: [], state: [], notification: [] } as never);
		expect(() => projectors.identity(empty as never)).not.toThrow();
		const absent = readEndoCockpitRegistryV0(tempRoot(), "pi.default");
		expect(absent.source.condition.state).toBe("absent");
		expect(() => projectors.identity(absent as never)).not.toThrow();
		expect(() => projectors.capabilities(absent as never)).not.toThrow();
		// Unopenable: no records, no position.
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
		};
		expect(() => projectors.identity(unopenable as never)).not.toThrow();
		expect(() => projectors.capabilities(unopenable as never)).not.toThrow();
		// Degraded keeps its records and position.
		const input = registryInput(records() as never) as any;
		const degraded = {
			...input,
			source: {
				...input.source,
				condition: {
					state: "degraded",
					tornTail: { bytes: 3, digest: "a".repeat(64) },
					sealedAt: null,
					error: null,
				},
			},
		};
		expect(() => projectors.identity(degraded as never)).not.toThrow();
		// Incoherent: a position advertised for an unopenable source; records for an absent one; none for a readable one.
		refused({ ...unopenable, source: { ...unopenable.source, watermark: input.source.watermark } });
		refused({ ...input, source: { ...input.source, condition: { ...input.source.condition, state: "absent" } } });
		refused({ ...input, records: null });
		refused({ ...(empty as any), source: { ...(empty as any).source, condition: { ...CLEAN, state: "readable" } } });
		refused({ ...input, source: { ...input.source, condition: { ...input.source.condition, state: "empty" } } });
		refused({ ...input, source: { ...input.source, watermark: null } });
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Evidence limits agree with the fingerprint the snapshot embeds
// ---------------------------------------------------------------------------------------------------------------

describe("evidence limits reconcile with the embedded fingerprint (P2)", () => {
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
	const accepted = (snapshot: unknown) => validateEndoCockpitSnapshotV0(snapshot) !== null;
	const base = specimenRecords();
	const admittedIndex = (s: ReturnType<typeof snapshotOf>) =>
		s.runtimes[0]!.capabilities.capabilities.findIndex((c) => c.status !== "unverified" && c.evidence !== null);
	/** Records whose first admitted capability cites evidence with changed dependencies. */
	const withDependencies = (change: Record<string, unknown>) => {
		const cited = base.state[0]!.capabilities.find(
			(c) => c.status !== "unverified" && c.evidenceId !== null,
		)!.evidenceId;
		return {
			...base,
			evidence: base.evidence.map((item) =>
				item.id === cited ? { ...item, dependencies: { ...item.dependencies, ...change } } : item,
			),
		};
	};
	const limitsOf = (s: ReturnType<typeof snapshotOf>) =>
		s.runtimes[0]!.capabilities.capabilities[admittedIndex(s)]!.limits.map((l) => l.code);
	const removeLimit = (s: unknown, code: string) =>
		mutated(s, (x) => {
			for (const view of x.runtimes[0].capabilities.capabilities)
				view.limits = view.limits.filter((l: any) => l.code !== code);
		});
	const addLimit = (s: ReturnType<typeof snapshotOf>, code: string) =>
		mutated(s, (x) => {
			const view = x.runtimes[0].capabilities.capabilities[admittedIndex(s)];
			view.limits.push({
				code,
				refs: [
					structuredClone(view.ref),
					structuredClone(view.evidence.ref),
					structuredClone(x.runtimes[0].identity.current.ref),
				],
			});
			view.limits.sort((p: any, q: any) => limitRank(p.code) - limitRank(q.code));
		});
	const limitRank = (code: string) => ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(code as never);

	it("accepts the matching case, and refuses a spurious limit the snapshot disproves", () => {
		const s = snapshotOf(base);
		expect(limitsOf(s)).not.toContain("evidence-identity-differs");
		expect(accepted(s)).toBe(true);
		for (const code of ["evidence-identity-differs", "evidence-confidence-differs", "evidence-reduced-identity"])
			expect(accepted(addLimit(s, code)), code).toBe(false);
	});

	it("requires evidence-identity-differs when the digests differ, and accepts the projector's output", () => {
		const s = snapshotOf(withDependencies({ identityDigest: "a".repeat(64) }));
		expect(limitsOf(s)).toContain("evidence-identity-differs");
		expect(limitsOf(s)).not.toContain("evidence-confidence-differs");
		expect(accepted(s)).toBe(true);
		expect(accepted(removeLimit(s, "evidence-identity-differs"))).toBe(false);
	});

	it("requires evidence-confidence-differs when the confidences differ", () => {
		const s = snapshotOf(withDependencies({ confidence: "reduced" }));
		expect(limitsOf(s)).toContain("evidence-confidence-differs");
		expect(limitsOf(s)).not.toContain("evidence-reduced-identity"); // not carried: its own fingerprint
		expect(accepted(s)).toBe(true);
		expect(accepted(removeLimit(s, "evidence-confidence-differs"))).toBe(false);
	});

	it("requires evidence-reduced-identity for carried evidence on a reduced identity, either side", () => {
		const carried = snapshotOf(
			withDependencies({ fingerprintId: "endo.evidence.pi-fingerprint.older", confidence: "reduced" }),
		);
		expect(limitsOf(carried)).toContain("evidence-reduced-identity");
		expect(accepted(carried)).toBe(true);
		expect(accepted(removeLimit(carried, "evidence-reduced-identity"))).toBe(false);
		// Carried but both strong: no reduced-identity limit, and none allowed.
		const strong = snapshotOf(withDependencies({ fingerprintId: "endo.evidence.pi-fingerprint.older" }));
		expect(limitsOf(strong)).not.toContain("evidence-reduced-identity");
		expect(accepted(strong)).toBe(true);
		expect(accepted(addLimit(strong, "evidence-reduced-identity"))).toBe(false);
		// The fingerprint itself reduced, the evidence strong and carried.
		const fp = { ...base.fingerprint[0]!, identity: { ...base.fingerprint[0]!.identity, confidence: "reduced" } };
		const reducedFp = snapshotOf({
			...withDependencies({ fingerprintId: "endo.evidence.pi-fingerprint.older" }),
			fingerprint: [fp],
		});
		expect(limitsOf(reducedFp)).toContain("evidence-reduced-identity");
		expect(accepted(reducedFp)).toBe(true);
		expect(accepted(removeLimit(reducedFp, "evidence-reduced-identity"))).toBe(false);
	});

	it("makes no inference when the state names a fingerprint the snapshot does not embed", () => {
		// The state names a historical observation; the evidence disagrees with the current fingerprint, which proves nothing.
		const historical = {
			...withDependencies({ identityDigest: "a".repeat(64), confidence: "reduced" }),
			state: [{ ...base.state[0]!, fingerprintId: "endo.evidence.pi-fingerprint.historical" }],
		};
		const s = snapshotOf(historical);
		expect(s.runtimes[0]!.capabilities.state!.currency).toBe("stale");
		expect(limitsOf(s)).not.toContain("evidence-identity-differs");
		expect(accepted(s)).toBe(true);
	});

	describe("a state naming the earlier-identity fingerprint the identity also embeds", () => {
		// Two fingerprints with different identities; the state names the first, so it is `previousDifferent`.
		const two = (extra: Record<string, unknown> = {}) => ({
			...withDependencies(extra),
			fingerprint: [base.fingerprint[0]!, fingerprintAt("/b/pi")],
		});
		it("requires and cites the limit with previousDifferent's reference", () => {
			const s = snapshotOf(two({ identityDigest: "a".repeat(64) }));
			const identity = s.runtimes[0]!.identity;
			expect(identity.previousDifferent!.id).toBe(s.runtimes[0]!.capabilities.state!.fingerprintId);
			const view = s.runtimes[0]!.capabilities.capabilities[admittedIndex(s)]!;
			const limit = view.limits.find((l) => l.code === "evidence-identity-differs")!;
			expect(limit.refs[2]).toEqual(identity.previousDifferent!.ref);
			expect(accepted(s)).toBe(true);
			expect(accepted(removeLimit(s, "evidence-identity-differs"))).toBe(false);
			// A spurious limit citing that reference, and one citing the current fingerprint instead, are refused.
			const spurious = mutated(s, (x) => {
				const v = x.runtimes[0].capabilities.capabilities[admittedIndex(s)];
				v.limits.push({
					code: "evidence-confidence-differs",
					refs: [
						structuredClone(v.ref),
						structuredClone(v.evidence.ref),
						structuredClone(x.runtimes[0].identity.previousDifferent.ref),
					],
				});
				v.limits.sort((p: any, q: any) => limitRank(p.code) - limitRank(q.code));
			});
			expect(accepted(spurious)).toBe(false);
			const wrongRef = mutated(s, (x) => {
				const v = x.runtimes[0].capabilities.capabilities[admittedIndex(s)];
				v.limits.find((l: any) => l.code === "evidence-identity-differs").refs[2] = structuredClone(
					x.runtimes[0].identity.current.ref,
				);
			});
			expect(accepted(wrongRef)).toBe(false);
		});

		it("requires the unrecorded-fingerprint limit only when the state names no embedded fingerprint", () => {
			const named = snapshotOf(two());
			expect(limitsOf(named)).not.toContain("state-fingerprint-not-recorded");
			expect(accepted(named)).toBe(true);
			const claimed = mutated(named, (x) => {
				const v = x.runtimes[0].capabilities.capabilities[admittedIndex(named)];
				v.limits.push({ code: "state-fingerprint-not-recorded", refs: [structuredClone(v.ref)] });
				v.limits.sort((p: any, q: any) => limitRank(p.code) - limitRank(q.code));
			});
			expect(accepted(claimed)).toBe(false);
			// Two kept, both embedded (different identities), the state names neither: required.
			const unnamed = snapshotOf({
				...two(),
				state: [{ ...base.state[0]!, fingerprintId: "endo.evidence.pi-fingerprint.historical" }],
			});
			expect(limitsOf(unnamed)).toContain("state-fingerprint-not-recorded");
			expect(accepted(unnamed)).toBe(true);
			expect(accepted(removeLimit(unnamed, "state-fingerprint-not-recorded"))).toBe(false);
			// Several kept and not all embedded (same identity: only the latest is a view): undecidable, so optional.
			const same = { ...base.fingerprint[0]!, id: `${base.fingerprint[0]!.id.slice(0, -1)}0` };
			const hidden = snapshotOf({
				...base,
				fingerprint: [base.fingerprint[0]!, same, { ...same, id: `${same.id.slice(0, -1)}1` }],
				state: [{ ...base.state[0]!, fingerprintId: "endo.evidence.pi-fingerprint.historical" }],
			});
			expect(accepted(hidden)).toBe(true);
			expect(accepted(removeLimit(hidden, "state-fingerprint-not-recorded"))).toBe(true);
		});
	});

	it("does not reason about unverified capabilities", () => {
		const first = base.state[0]!;
		const unverified = {
			...base,
			state: [
				{
					...first,
					capabilities: first.capabilities.map((c) => ({
						...c,
						status: "unverified",
						classification: null,
						evidenceId: null,
					})),
				},
			],
		};
		expect(accepted(snapshotOf(unverified))).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 6 and 7. Impossible diagnostics
// ---------------------------------------------------------------------------------------------------------------

describe("a duplicate-record-id note cannot name the first fingerprint (P2)", () => {
	const a = fingerprintAt("/a/pi");
	// Same identity as `a`, so only the latest is presented and position 0 is kept but not a view.
	const twin = { ...a, id: `${a.id.slice(0, -1)}${a.id.endsWith("0") ? "1" : "0"}` };
	const records = { ...specimenRecords(), fingerprint: [a, twin] };
	const identity = identityOf(records);
	const capabilities = capabilitiesOf(records);
	const withNote = <T>(value: T, code: string, index: number) =>
		mutated(value, (v) => {
			const real = v.current?.ref ?? v.state.ref;
			const published = { ...real, kind: "fingerprint", index, id: index === 0 ? idAt0(identity) : real.id };
			v.notes.push({ code, refs: [published] });
		});
	const idAt0 = (i: typeof identity) =>
		i.source.watermark!.lastIds.fingerprint!.replace(/.$/, (c) => (c === "0" ? "1" : "0"));

	it("refuses the note at index 0 in both views, and accepts it at a later position", () => {
		expect(identity.previousDifferent).toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		expect.soft(validateEndoCockpitRuntimeIdentityV0(withNote(identity, "duplicate-record-id", 0))).toBeNull();
		expect.soft(validateEndoCockpitCapabilityStateV0(withNote(capabilities, "duplicate-record-id", 0))).toBeNull();
		// The same record is fine to discard as foreign, and a later position can repeat an earlier id.
		const dup = projectEndoCockpitRuntimeIdentityV0(
			registryInput({ ...specimenRecords(), fingerprint: [a, { ...a }] } as never),
			TEST_KEY,
		);
		expect(dup.notes.map((n) => [n.code, (n.refs[0] as { index: number }).index])).toEqual([
			["duplicate-record-id", 1],
		]);
		const first = identityOf({ ...specimenRecords(), fingerprint: [foreign(a), twin] });
		expect(first.notes.map((n) => [n.code, (n.refs[0] as { index: number }).index])).toEqual([
			["foreign-attachment-record", 0],
		]);
		expect(validateEndoCockpitRuntimeIdentityV0(first)).not.toBeNull();
	});
});

describe("a duplicate-record-id note needs an earlier fingerprint in the ledger (P2)", () => {
	const a = fingerprintAt("/a/pi");
	const twin = (id: string) => ({ ...a, id });
	const b = twin(`${a.id.slice(0, -1)}${a.id.endsWith("0") ? "1" : "0"}`);
	const c = twin(`${a.id.slice(0, -1)}${a.id.endsWith("2") ? "3" : "2"}`);
	const records = { ...specimenRecords(), fingerprint: [foreign(a), b, c] };
	const identity = identityOf(records);
	const capabilities = capabilitiesOf(records);
	const forgedAt = <T extends { notes: unknown[] }>(value: T, index: number) =>
		mutated(value, (v) => {
			const real = identity.current!.ref as { index: number; id: string };
			v.notes.push({
				code: "duplicate-record-id",
				refs: [{ ...structuredClone(real), index, id: index === 1 ? "endo.evidence.pi-fingerprint.zz" : real.id }],
			});
		});

	it("refuses a duplicate at the first kept position when every earlier fingerprint is foreign, in both views", () => {
		expect(identity.current!.ref).toMatchObject({ index: 2 });
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		expect.soft(validateEndoCockpitRuntimeIdentityV0(forgedAt(identity, 1))).toBeNull();
		expect.soft(validateEndoCockpitCapabilityStateV0(forgedAt(capabilities, 1))).toBeNull();
	});

	it("accepts the projector's duplicate once an earlier fingerprint entered the ledger", () => {
		const real = identityOf({ ...specimenRecords(), fingerprint: [foreign(a), b, { ...b }] });
		expect(real.notes.map((n) => n.code)).toContain("duplicate-record-id");
		expect(validateEndoCockpitRuntimeIdentityV0(real)).not.toBeNull();
	});
});

describe("duplicate-capability needs a retained capability (P2)", () => {
	const base = specimenRecords();
	const emptyState = { ...base.state[0]!, capabilities: [] };
	const empty = capabilitiesOf({ ...base, state: [emptyState] });
	const withNote = <T extends { state: { ref: unknown } | null }>(value: T) =>
		mutated(value, (v) => {
			v.notes.push({ code: "duplicate-capability", refs: [structuredClone(v.state.ref)] });
		});

	it("refuses the note when no capability is presented, and accepts the projector's empty state", () => {
		expect(empty.state).not.toBeNull();
		expect(empty.capabilities).toHaveLength(0);
		expect(validateEndoCockpitCapabilityStateV0(empty)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(withNote(empty))).toBeNull();
	});

	it("accepts a genuine duplicate beside its retained first occurrence, and refuses a wrong reference", () => {
		const first = base.state[0]!;
		const twice = capabilitiesOf({
			...base,
			state: [{ ...first, capabilities: [first.capabilities[0]!, first.capabilities[0]!] }],
		});
		expect(twice.capabilities).toHaveLength(1);
		expect(twice.notes.map((n) => n.code)).toContain("duplicate-capability");
		expect(validateEndoCockpitCapabilityStateV0(twice)).not.toBeNull();
		const wrong = mutated(twice, (v) => {
			v.notes.find((n: { code: string }) => n.code === "duplicate-capability").refs = [];
		});
		expect(validateEndoCockpitCapabilityStateV0(wrong)).toBeNull();
	});
});
