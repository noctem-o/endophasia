// PR #57 review round 17: one id is one position, admitted capabilities sharing an evidence record, and limits that belong to
// the state rather than to a capability. Every negative is its own test so each fails for its own reason.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cockpitAliasesV0, registryWatermarkV0 } from "../cockpit/projections/common.ts";
import {
	ENDO_COCKPIT_LIMIT_CODES_V0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import { ENDO_CONFORMANCE_CLASSIFICATIONS_V0 } from "../protocol/evaluation.ts";
import { endoCapabilityStatusForV0, endoHarnessIdentityBasisV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import {
	changeRecord,
	event,
	removeTempRoots,
	specimen,
	specimenRecords,
	stored,
	tempRoot,
} from "./cockpit-fixtures.ts";
import {
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
const snapshotFrom = (identity: unknown, capabilities: unknown) => ({
	schemaVersion: "endo.cockpit-snapshot.v0",
	projectionVersion: "cockpit-snapshot.3",
	consistency: "independent-sources",
	timeline,
	runtimes: [{ identity, capabilities }],
});
const snapshotOf = (records: unknown) => snapshotFrom(identityOf(records), capabilitiesOf(records));
const base = specimenRecords();
const rank = (code: string) => ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(code as never);

// ---------------------------------------------------------------------------------------------------------------
// 1. One id is one position
// ---------------------------------------------------------------------------------------------------------------

describe("a runtime-disagreement note cites records with distinct ids (P2)", () => {
	const other = fingerprintAt("/a/pi", "other");
	// a (index 0, runtime "other") and b..d ("pi"): the projector cites index 0 and the latest, `d`.
	const records = {
		...base,
		fingerprint: [other, fb, fc, fd],
		change: [changeRecord(), changeRecord({ id: "endo.evidence.test-change.2" })],
	};
	const identity = identityOf(records);
	const note = identity.notes.find((n) => n.code === "runtime-disagreement")!;
	const current = identity.current!.ref as { id: string };
	const withRefs = (refs: unknown[]) =>
		mutated(identity, (x) => {
			x.notes.find((n: { code: string }) => n.code === "runtime-disagreement").refs = structuredClone(refs);
		});
	const at = (kind: string, index: number, id: string) => ({
		domain: "harness-registry",
		attachment: "pi.default",
		kind,
		index,
		id,
	});
	const a0 = aliasOf(other.id);

	it("accepts the projector's note and distinct kept positions with distinct ids", () => {
		expect(note.refs).toHaveLength(2);
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				withRefs([at("fingerprint", 0, a0), at("fingerprint", 1, aliasOf(fb.id)), current]),
			),
		).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withRefs([at("fingerprint", 0, a0), current]))).not.toBeNull();
	});

	it("refuses two positions of one kind carrying one id", () => {
		const forged = withRefs([at("fingerprint", 0, a0), at("fingerprint", 1, a0), current]);
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	it("refuses two kinds carrying one id", () => {
		const forged = withRefs([at("change", 0, current.id), current]);
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	it("refuses a repeated id among several references", () => {
		// (Positions 2 and 3 are presented views whose ids the older one-position-one-id rule already fixes; 0, 1 and change 0 are not.)
		const forged = withRefs([
			at("fingerprint", 0, a0),
			at("fingerprint", 1, aliasOf(fb.id)),
			at("change", 0, aliasOf(fb.id)),
			current,
		]);
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
		const distinct = withRefs([
			at("fingerprint", 0, a0),
			at("fingerprint", 1, aliasOf(fb.id)),
			at("change", 0, "endo.evidence.test-change.1"),
			current,
		]);
		expect(validateEndoCockpitRuntimeIdentityV0(distinct)).not.toBeNull();
	});

	it("still refuses, under the existing rules, a repeated position and a discarded one", () => {
		expect(
			validateEndoCockpitRuntimeIdentityV0(withRefs([at("fingerprint", 0, a0), at("fingerprint", 0, a0), current])),
		).toBeNull();
	});

	it("still refuses a reference to a discarded position (the cleaning rule, not the id rule)", () => {
		const foreignFirst = { ...other, attachment: "other.attachment" };
		const discarded = identityOf({ ...base, fingerprint: [foreignFirst, fb] });
		expect(validateEndoCockpitRuntimeIdentityV0(discarded)).not.toBeNull();
		const forged = mutated(discarded, (x) => {
			x.notes.push({
				code: "runtime-disagreement",
				refs: [at("fingerprint", 0, a0), structuredClone(x.current.ref)],
			});
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	it("holds across a snapshot: a change position carrying a cited evidence id", () => {
		const cited = base.state[0]!.capabilities.find((c) => c.status !== "unverified" && c.evidenceId !== null)!
			.evidenceId!;
		const recordsWith = { ...base, fingerprint: [other, fb], change: records.change };
		const s = snapshotOf(recordsWith);
		const forged = mutated(s, (x) => {
			const n = x.runtimes[0].identity.notes.find((m: { code: string }) => m.code === "runtime-disagreement");
			n.refs = [n.refs[0], at("change", 0, aliasOf(cited)), n.refs[1]];
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forged.runtimes[0]!.identity)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(s)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Capabilities sharing one evidence record
// ---------------------------------------------------------------------------------------------------------------

describe("admitted capabilities sharing an evidence record (P2)", () => {
	const first = base.state[0]!;
	const sharingState = (count: number, edit: (entries: any[]) => void = () => {}) => {
		const entries = first.capabilities.map((c) => ({ ...c }));
		for (let at = 1; at < count; at += 1) entries[at]!.evidenceId = entries[0]!.evidenceId;
		edit(entries);
		return { ...first, capabilities: entries };
	};
	const project = (state: unknown, extra: Record<string, unknown> = {}) =>
		capabilitiesOf({ ...base, ...extra, state: [state] });
	const codes = (v: { limits: { code: string }[] }) => v.limits.map((l) => l.code);
	const view = (p: ReturnType<typeof project>, at: number) => p.capabilities[at]!;
	const without = (p: ReturnType<typeof project>, at: number, code: string) =>
		mutated(p, (x) => {
			x.capabilities[at].limits = x.capabilities[at].limits.filter((l: { code: string }) => l.code !== code);
		});
	const withLimit = (p: ReturnType<typeof project>, at: number, code: string) =>
		mutated(p, (x) => {
			const v = x.capabilities[at];
			v.limits.push({ code, refs: [structuredClone(v.ref), structuredClone(v.evidence.ref)] });
			v.limits.sort((m: { code: string }, n: { code: string }) => rank(m.code) - rank(n.code));
		});
	const ok = (p: unknown) => validateEndoCockpitCapabilityStateV0(p) !== null;

	it("accepts the projector's output where two capabilities share the record", () => {
		const p = project(sharingState(2));
		expect(view(p, 0).evidence!.ref).toEqual(view(p, 1).evidence!.ref);
		expect(codes(view(p, 0))).not.toContain("evidence-capability-differs");
		expect(codes(view(p, 1))).toContain("evidence-capability-differs");
		expect(ok(p)).toBe(true);
	});

	it("refuses both omitting the mismatch limit (Codex's mutation)", () => {
		const p = project(sharingState(2));
		expect(ok(without(p, 1, "evidence-capability-differs"))).toBe(false);
	});

	it("refuses two omissions among three, accepts zero or one", () => {
		const p = project(sharingState(3));
		expect(ok(p)).toBe(true);
		expect(ok(without(p, 2, "evidence-capability-differs"))).toBe(false);
		// Every member may carry it: the record might name a fourth capability. Exactly one may omit it.
		expect(ok(withLimit(p, 0, "evidence-capability-differs"))).toBe(true);
		const none = withLimit(p, 0, "evidence-capability-differs");
		expect(ok(without(none, 1, "evidence-capability-differs"))).toBe(true);
	});

	it("does not restrict capabilities citing different records, or unverified entries", () => {
		const p = project(first);
		expect(ok(p)).toBe(true);
		const admitted = p.capabilities.filter((c) => c.status !== "unverified");
		expect(admitted.every((c) => !codes(c).includes("evidence-capability-differs"))).toBe(true);
		const mixed = project(
			sharingState(
				2,
				(entries) =>
					void Object.assign(entries[2], { status: "unverified", classification: null, evidenceId: null }),
			),
		);
		expect(mixed.capabilities.some((c) => c.status === "unverified")).toBe(true);
		expect(ok(mixed)).toBe(true);
	});

	it("keeps entry-specific limits free to differ within a group", () => {
		// The second entry records another classification than the evidence's: its own limit, not the first entry's.
		const evidenceClassification = base.evidence.find(
			(item) => item.id === first.capabilities[0]!.evidenceId,
		)!.classification;
		const different = ENDO_CONFORMANCE_CLASSIFICATIONS_V0.find((c) => c !== evidenceClassification)!;
		const p = project(
			sharingState(2, (entries) => {
				entries[1].classification = different;
				entries[1].status = endoCapabilityStatusForV0(different);
			}),
		);
		expect(codes(view(p, 1))).toContain("evidence-classification-differs");
		expect(codes(view(p, 0))).not.toContain("evidence-classification-differs");
		expect(ok(p)).toBe(true);
	});

	it("requires the limits that follow from the record and the state to agree within a group", () => {
		const cited = first.capabilities[0]!.evidenceId!;
		const evidence = base.evidence.map((item) =>
			item.id === cited ? { ...item, dependencies: { ...item.dependencies, identityDigest: "a".repeat(64) } } : item,
		);
		const p = project(sharingState(2), { evidence });
		expect(codes(view(p, 0))).toContain("evidence-identity-differs");
		expect(codes(view(p, 1))).toContain("evidence-identity-differs");
		expect(ok(p)).toBe(true);
		expect(ok(without(p, 1, "evidence-identity-differs"))).toBe(false);
	});

	it("round-trips a source-backed registry holding shared citations through the reader", () => {
		const root = tempRoot();
		const registry = openEndoHarnessRegistryV0(root, "pi.default");
		registry.append("fingerprint", base.fingerprint[0]!);
		for (const record of base.evidence) registry.append("evidence", record);
		registry.append("state", sharingState(3) as never);
		const read = readEndoCockpitRegistryV0(root, "pi.default");
		const p = projectEndoCockpitCapabilityStateV0(read, TEST_KEY);
		expect(view(p, 1).evidence!.id).toBe(view(p, 0).evidence!.id);
		expect(ok(p)).toBe(true);
		expect(ok(without(p, 2, "evidence-capability-differs"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Limits of the state are the state's
// ---------------------------------------------------------------------------------------------------------------

describe("state-level limits are uniform across admitted capabilities (P2)", () => {
	const first = base.state[0]!;
	const historical = "endo.evidence.pi-fingerprint.historical";
	const project = (fingerprint: unknown[], state: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
		capabilitiesOf({ ...base, ...extra, fingerprint, state: [{ ...first, ...state }] });
	const codes = (v: { limits: { code: string }[] }) => v.limits.map((l) => l.code);
	const admitted = (p: ReturnType<typeof capabilitiesOf>) =>
		p.capabilities.flatMap((c, at) => (c.status === "unverified" ? [] : [at]));
	const strip = (p: ReturnType<typeof capabilitiesOf>, which: number[], code: string) =>
		mutated(p, (x) => {
			for (const at of which)
				x.capabilities[at].limits = x.capabilities[at].limits.filter((l: { code: string }) => l.code !== code);
		});
	const ok = (p: unknown) => validateEndoCockpitCapabilityStateV0(p) !== null;

	it("refuses one admitted capability dropping state-fingerprint-not-recorded among several kept fingerprints", () => {
		const p = project([fa, fb, fc], { fingerprintId: historical });
		const at = admitted(p);
		expect(at.length).toBeGreaterThan(1);
		expect(at.every((i) => codes(p.capabilities[i]!).includes("state-fingerprint-not-recorded"))).toBe(true);
		expect(ok(p)).toBe(true);
		expect(ok(strip(p, [at[0]!], "state-fingerprint-not-recorded"))).toBe(false);
		expect(ok(strip(p, [at[1]!], "state-fingerprint-not-recorded"))).toBe(false);
	});

	it("accepts all-or-none among several kept, since a historical fingerprint cannot be disproved", () => {
		const p = project([fa, fb, fc], { fingerprintId: historical });
		expect(ok(strip(p, admitted(p), "state-fingerprint-not-recorded"))).toBe(true);
	});

	it("counts only admitted entries: an unverified one keeps its empty limits and the rest still agree", () => {
		const entries = first.capabilities.map((c, at) =>
			at === 0 ? { ...c, status: "unverified", classification: null, evidenceId: null } : c,
		);
		const mixed = project([fa, fb, fc], { fingerprintId: historical, capabilities: entries });
		expect(mixed.capabilities[0]!.limits).toEqual([]);
		expect(ok(mixed)).toBe(true);
	});

	it("refuses an admitted capability dropping the limit in a mixed state", () => {
		const entries = first.capabilities.map((c, at) =>
			at === 0 ? { ...c, status: "unverified", classification: null, evidenceId: null } : c,
		);
		const mixed = project([fa, fb, fc], { fingerprintId: historical, capabilities: entries });
		expect(ok(strip(mixed, [admitted(mixed)[0]!], "state-fingerprint-not-recorded"))).toBe(false);
	});

	it("leaves a lone admitted entry, and a state with none, free", () => {
		const lone = project([fa, fb, fc], {
			fingerprintId: historical,
			capabilities: first.capabilities.map((c, at) =>
				at === 0 ? c : { ...c, status: "unverified", classification: null, evidenceId: null },
			),
		});
		expect(admitted(lone)).toHaveLength(1);
		expect(ok(strip(lone, admitted(lone), "state-fingerprint-not-recorded"))).toBe(true);
		const none = project([fa, fb, fc], {
			fingerprintId: null,
			capabilities: first.capabilities.map((c) => ({
				...c,
				status: "unverified",
				classification: null,
				evidenceId: null,
			})),
		});
		expect(admitted(none)).toHaveLength(0);
		expect(ok(none)).toBe(true);
	});

	it("keeps the zero- and one-kept requirements where they already decide", () => {
		for (const list of [[], [fa]]) {
			const p = project(list, { fingerprintId: historical });
			expect(ok(p)).toBe(true);
			expect(ok(strip(p, [admitted(p)[0]!], "state-fingerprint-not-recorded"))).toBe(false);
			expect(ok(strip(p, admitted(p), "state-fingerprint-not-recorded"))).toBe(false);
		}
	});

	it("refuses 'not recorded' beside a limit that cites the named fingerprint", () => {
		const cited = first.capabilities[0]!.evidenceId!;
		const evidence = base.evidence.map((item) =>
			item.id === cited ? { ...item, dependencies: { ...item.dependencies, identityDigest: "a".repeat(64) } } : item,
		);
		// The state names the older kept fingerprint `fb`; the evidence disagrees with it.
		const p = project([fa, fb, fc], { fingerprintId: fb.id }, { evidence });
		const at = admitted(p);
		expect(codes(p.capabilities[at[0]!]!)).toContain("evidence-identity-differs");
		expect(at.every((i) => !codes(p.capabilities[i]!).includes("state-fingerprint-not-recorded"))).toBe(true);
		expect(ok(p)).toBe(true);
		// Uniformly claiming the named fingerprint is unrecorded contradicts the limit that cites it.
		const claimed = mutated(p, (x) => {
			for (const i of at) {
				const v = x.capabilities[i];
				v.limits.push({ code: "state-fingerprint-not-recorded", refs: [structuredClone(v.ref)] });
				v.limits.sort((m: { code: string }, n: { code: string }) => rank(m.code) - rank(n.code));
			}
		});
		expect(ok(claimed)).toBe(false);
	});

	it("keeps the fingerprint part of runtime-differs the same for every admitted capability", () => {
		// The state names `fb`, a fingerprint of another runtime family than the state's.
		const other = fingerprintAt("/b/pi", "other");
		const p = project([fa, other, fc], { fingerprintId: other.id });
		const at = admitted(p);
		expect(at.every((i) => codes(p.capabilities[i]!).includes("runtime-differs"))).toBe(true);
		expect(ok(p)).toBe(true);
		expect(ok(strip(p, [at[0]!], "runtime-differs"))).toBe(false);
	});

	it("accepts a stale state naming an older kept fingerprint whose evidence matches, with the limit uniformly added", () => {
		// Several kept, nothing cites the named fingerprint: a single view cannot tell it is recorded (the snapshot, which embeds
		// the previous different observation, can; that is the round-16 rule).
		const older = base.fingerprint[0]!;
		const p = project([older, fb, fc], { fingerprintId: older.id });
		expect(codes(p.capabilities[admitted(p)[0]!]!)).not.toContain("evidence-identity-differs");
		expect(ok(p)).toBe(true);
		const claimed = mutated(p, (x) => {
			for (const i of admitted(p)) {
				const v = x.capabilities[i];
				v.limits.push({ code: "state-fingerprint-not-recorded", refs: [structuredClone(v.ref)] });
				v.limits.sort((m: { code: string }, n: { code: string }) => rank(m.code) - rank(n.code));
			}
		});
		expect(ok(claimed)).toBe(true);
	});
});

describe("a reference to the latest kept fingerprint stays at its position (registry identity)", () => {
	const first = base.state[0]!;
	it("refuses moving the newest-fingerprint reference to an unpresented position in every capability", () => {
		const p = capabilitiesOf({ ...base, fingerprint: [fa, fb, fc], state: [{ ...first, fingerprintId: fb.id }] });
		expect(p.state!.currency).toBe("stale");
		const newest = (x: any) => x.limits.find((l: any) => l.code === "state-not-for-latest-fingerprint").refs[1];
		expect(newest(p.capabilities.find((c) => c.status !== "unverified")!).index).toBe(2);
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
		const moved = mutated(p, (x) => {
			for (const view of x.capabilities) if (view.status !== "unverified") newest(view).index = 0;
		});
		expect(validateEndoCockpitCapabilityStateV0(moved)).toBeNull();
	});
});

describe("projector output the group and state rules must accept", () => {
	const first = base.state[0]!;
	const project = (state: unknown, fingerprint: unknown[] = [fa]) =>
		capabilitiesOf({ ...base, fingerprint, state: [state] });
	const codes = (v: { limits: { code: string }[] }) => v.limits.map((l) => l.code);

	it("a group whose evidence names a third capability: every member carries the mismatch", () => {
		const entries = first.capabilities.map((c) => ({ ...c }));
		entries[1]!.evidenceId = entries[5]!.evidenceId;
		entries[2]!.evidenceId = entries[5]!.evidenceId;
		entries[5]!.evidenceId = entries[0]!.evidenceId;
		const p = project({ ...first, capabilities: entries });
		expect(codes(p.capabilities[1]!)).toContain("evidence-capability-differs");
		expect(codes(p.capabilities[2]!)).toContain("evidence-capability-differs");
		expect(p.capabilities[1]!.evidence!.ref).toEqual(p.capabilities[2]!.evidence!.ref);
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
	});

	it("an entry citing nothing recorded still carries the state's runtime-differs fingerprints", () => {
		const other = fingerprintAt("/b/pi", "other");
		const entries = first.capabilities.map((c, at) =>
			at === 1 ? { ...c, evidenceId: "endo.evidence.pi-capability.missing" } : c,
		);
		const p = project({ ...first, fingerprintId: other.id, capabilities: entries }, [fa, other, fc]);
		expect(codes(p.capabilities[1]!)).toContain("evidence-record-missing");
		expect(codes(p.capabilities[1]!)).toContain("runtime-differs");
		expect(
			p.capabilities.filter((c) => c.status !== "unverified").every((c) => codes(c).includes("runtime-differs")),
		).toBe(true);
		expect(validateEndoCockpitCapabilityStateV0(p)).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Soundness: modes added for this round, through both views and the snapshot
// ---------------------------------------------------------------------------------------------------------------

describe("projector output over the new modes validates (soundness)", () => {
	const first = base.state[0]!;
	it("accepts shared citations, older-fingerprint states and runtime-differing fingerprints", () => {
		const share = (count: number) => ({
			...first,
			capabilities: first.capabilities.map((c, at) =>
				at > 0 && at < count ? { ...c, evidenceId: first.capabilities[0]!.evidenceId } : c,
			),
		});
		const other = fingerprintAt("/x/pi", "other");
		let run = 0;
		for (const fingerprint of [[fa], [fa, fb], [fa, fb, fc], [fa, other, fc], [other, fb, fc, fd]])
			for (const count of [1, 2, 3])
				for (const named of [null, "older", "historical", "latest"] as const) {
					const kept = fingerprint as { id: string }[];
					const fingerprintId =
						named === null
							? first.fingerprintId
							: named === "older"
								? kept[0]!.id
								: named === "latest"
									? kept.at(-1)!.id
									: "endo.evidence.pi-fingerprint.historical";
					const records = { ...base, fingerprint, state: [{ ...share(count), fingerprintId }] };
					const label = `${kept.length} fp / ${count} sharing / ${String(named)}`;
					try {
						expect(validateEndoCockpitSnapshotV0(snapshotOf(records)), label).not.toBeNull();
						run += 1;
					} catch (error) {
						throw new Error(`${label}: ${(error as Error).message}`);
					}
				}
		expect(run).toBe(60);
	});
});
