// PR #57 review round 11: fingerprint commitments presented as keyed tokens, ineligible usage counted as withheld, record ids
// unique across kinds, a window's first position presented, and discarded-record notes that name their record.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cockpitAliasesV0 } from "../cockpit/projections/common.ts";
import {
	ENDO_COCKPIT_LIMIT_CODES_V0,
	type EndoCockpitRefV0,
	type EndoCockpitSessionTimelineV0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import { isEndoCockpitContentAddressedIdV0, isEndoCockpitPublicIdV0 } from "../protocol/cockpit-fields.ts";
import { ENDO_CONFORMANCE_CLASSIFICATIONS_V0 } from "../protocol/evaluation.ts";
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
	OTHER_KEY,
	projectEndoCockpitCapabilityStateV0,
	projectEndoCockpitRuntimeIdentityV0,
	projectEndoCockpitSessionTimelineV0,
	publicIdV0,
	TEST_KEY,
} from "./cockpit-keyed.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const CLEAN = { state: "readable", tornTail: null, sealedAt: null, error: null } as const;

function logSource(length: number, lastEventId: string | null, keyId = TEST_KEY.keyId) {
	return {
		domain: "event-log" as const,
		condition: { ...CLEAN, state: length === 0 ? ("empty" as const) : ("readable" as const) },
		watermark: {
			length,
			lastEventId,
			prefixDigest: length === 0 ? null : sha256HexV0(`prefix-${length}`),
			keyId,
		},
	};
}

function registryInput(records: ReturnType<typeof specimenRecords>, keyId = TEST_KEY.keyId, key = TEST_KEY) {
	const counts = {
		fingerprint: records.fingerprint.length,
		change: records.change.length,
		evidence: records.evidence.length,
		state: records.state.length,
		notification: records.notification.length,
	};
	const alias = cockpitAliasesV0(key);
	const last = (list: readonly { id: string }[]) => (list.length === 0 ? null : alias.id(list.at(-1)!.id));
	return {
		source: {
			domain: "harness-registry" as const,
			attachment: "pi.default",
			condition: { ...CLEAN, state: "readable" as const },
			watermark: {
				counts,
				lastIds: {
					fingerprint: last(records.fingerprint),
					change: last(records.change),
					evidence: last(records.evidence),
					state: null,
					notification: last(records.notification),
				},
				contentDigest: sha256HexV0(canonicalEndoJsonV0(records)),
				keyId,
			},
		},
		records,
	};
}

type RegistryRef = Extract<EndoCockpitRefV0, { domain: "harness-registry" }>;
const mutated = <T>(value: T, edit: (copy: any) => void): T => {
	const copy = structuredClone(value);
	edit(copy);
	return copy;
};

function timelineOf(events: ReturnType<typeof event>[], key = TEST_KEY): EndoCockpitSessionTimelineV0 {
	return projectEndoCockpitSessionTimelineV0(
		{
			source: logSource(events.length, events.at(-1)?.id ?? null, key.keyId),
			afterSequence: 0,
			events: stored(events),
		},
		key,
	);
}

// ---------------------------------------------------------------------------------------------------------------
// P1: fingerprint commitments
// ---------------------------------------------------------------------------------------------------------------

/** A fingerprint of a runtime installed at `realPath`, with its id and identity digest as the Pi attachment makes them. */
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

const CANDIDATE_PATHS = [
	"/home/alice/.npm/bin/pi",
	"/home/bob/.local/bin/pi",
	"/usr/local/bin/pi",
	"/opt/pi/bin/pi",
	"/home/carol/pi/cli.js",
];
const VICTIM_PATH = "/home/alice/.npm/bin/pi";

function attachedEvents(fingerprint: ReturnType<typeof fingerprintAt>, other: ReturnType<typeof fingerprintAt>) {
	return [
		event("harness.attached", {
			instance: "endo.session.test.one",
			fingerprintId: fingerprint.id,
			identityDigest: fingerprint.identity.digest,
			version: { status: "reported", value: "1.0.0" },
			mapping: "pi-mapping-1",
		}),
		event("harness.runtime-changed", {
			previousFingerprintId: fingerprint.id,
			currentFingerprintId: other.id,
		}),
	];
}

describe("fingerprint commitments are presented as keyed tokens (P1)", () => {
	const victim = fingerprintAt(VICTIM_PATH);
	const other = fingerprintAt("/home/alice/.npm/bin/pi2");
	const candidates = CANDIDATE_PATHS.map(fingerprintAt);
	const events = attachedEvents(victim, other);

	function everything(key = TEST_KEY) {
		const base = specimenRecords();
		const records = {
			...base,
			fingerprint: [victim, other],
			change: [changeRecord()],
			notification: [notificationRecord()],
			evidence: base.evidence.map((item) => ({
				...item,
				dependencies: { ...item.dependencies, fingerprintId: victim.id, identityDigest: victim.identity.digest },
			})),
			state: [{ ...base.state[0]!, fingerprintId: victim.id }],
		};
		const input = registryInput(records as never, key.keyId, key);
		const identity = projectEndoCockpitRuntimeIdentityV0(input as never, key);
		const capabilities = projectEndoCockpitCapabilityStateV0(input as never, key);
		const timeline = timelineOf(events, key);
		return {
			identity,
			capabilities,
			timeline,
			input,
			serialized: JSON.stringify({ identity, capabilities, timeline }),
		};
	}

	it("the old public values confirm a guessed path; the new output confirms none", () => {
		// The oracle is real: the true candidate recomputes the very id and digest the attachment records.
		const guess = candidates.find((candidate) => candidate.id === victim.id);
		expect(guess).toBeDefined();
		expect(guess!.identity.digest).toBe(victim.identity.digest);
		// Everything the cockpit now publishes, serialized: no candidate's id or digest, raw, appears in it - so none of the
		// guesses can be confirmed without the key.
		const { serialized } = everything();
		for (const candidate of candidates) {
			expect(serialized).not.toContain(candidate.id.split(".").at(-1));
			expect(serialized).not.toContain(candidate.identity.digest);
		}
		expect(serialized).not.toContain(VICTIM_PATH);
	});

	it("no content-addressed id or identity digest of any record is serialized raw", () => {
		const { serialized, input } = everything();
		const records = input.records as ReturnType<typeof specimenRecords>;
		const raw = [
			...records.fingerprint.flatMap((r) => [r.id.split(".").at(-1)!, r.identity.digest]),
			...records.evidence.flatMap((r) => [r.id.split(".").at(-1)!, r.dependencies.identityDigest]),
			...records.change.map((r) => r.id.split(".").at(-1)!),
			...records.notification.map((r) => r.id.split(".").at(-1)!),
		];
		const hashes = raw.filter((value) => /^[0-9a-f]{64}$/.test(value));
		expect(hashes.length).toBeGreaterThan(5);
		for (const value of hashes) expect(serialized, value).not.toContain(value);
	});

	it("the attached event, the runtime-changed event and the registry projections agree under one key", () => {
		const { timeline, identity, capabilities } = everything();
		const [attached, changed] = timeline.entries;
		const shown = publicIdV0(victim.id);
		expect(shown).not.toBe(victim.id);
		expect(shown).toMatch(/^endo\.evidence\.withheld-[0-9a-f]{32}$/);
		expect(attached!.fields.fingerprintId).toEqual({ basis: "observed", value: shown });
		expect(changed!.fields.previousFingerprintId).toEqual({ basis: "observed", value: shown });
		expect(changed!.fields.currentFingerprintId).toEqual({ basis: "observed", value: publicIdV0(other.id) });
		// The same token the registry views carry for the same identity digest, under the same purpose.
		const token = cockpitAliasesV0(TEST_KEY).digest("identity", victim.identity.digest);
		expect(attached!.fields.identityDigest).toEqual({ basis: "derived", value: token });
		expect(identity.previousDifferent!.id).toBe(shown);
		expect(
			identity.previousDifferent!.identity.basis === "derived" && identity.previousDifferent!.identity.value.digest,
		).toBe(token);
		expect(capabilities.state!.fingerprintId).toBe(shown);
		expect(capabilities.capabilities.find((c) => c.evidence !== null)!.evidence!.dependencies.fingerprintId).toBe(
			shown,
		);
		expect(capabilities.capabilities.find((c) => c.evidence !== null)!.evidence!.dependencies.identityDigest).toBe(
			token,
		);
	});

	it("is deterministic under one key and different under another", () => {
		const one = everything(TEST_KEY);
		expect(everything(TEST_KEY).serialized).toBe(one.serialized);
		const two = everything(OTHER_KEY);
		const a = one.timeline.entries[0]!.fields;
		const b = two.timeline.entries[0]!.fields;
		expect(b.fingerprintId).not.toEqual(a.fingerprintId);
		expect(b.identityDigest).not.toEqual(a.identityDigest);
		expect(two.identity.previousDifferent!.id).not.toBe(one.identity.previousDifferent!.id);
		// Neither key's output contains the other's tokens.
		expect(two.serialized).not.toContain(
			one.timeline.entries[0]!.fields.identityDigest.basis === "derived" ? (a.identityDigest as any).value : "",
		);
	});

	it("never carries the key or the recorded digest, and a malformed digest is withheld, not passed through", () => {
		const { serialized } = everything();
		expect(serialized).not.toContain(TEST_KEY.keyId === "" ? "x" : "5a5a5a5a5a5a5a5a");
		const bad = timelineOf([
			event("harness.attached", {
				instance: "endo.session.test.one",
				fingerprintId: victim.id,
				identityDigest: "/home/alice/pi",
			}),
			event("harness.attached", { instance: "endo.session.test.one", fingerprintId: victim.id, identityDigest: 7 }),
		]);
		expect(bad.entries[0]!.fields.identityDigest).toMatchObject({ basis: "unavailable" });
		expect(bad.entries[1]!.fields.identityDigest).toBeUndefined();
		expect(validateEndoCockpitSessionTimelineV0(bad)).not.toBeNull();
	});

	it("the wire refuses a raw content-addressed id, and still accepts the keyed form (structure only)", () => {
		expect(isEndoCockpitContentAddressedIdV0(victim.id)).toBe(true);
		expect(isEndoCockpitPublicIdV0(victim.id)).toBe(false);
		expect(isEndoCockpitPublicIdV0(publicIdV0(victim.id))).toBe(true);
		// Event ids hash only identifiers the cockpit presents: not in the family.
		expect(isEndoCockpitContentAddressedIdV0(`endo.event.pi-entry.${"a".repeat(48)}`)).toBe(false);
		expect(isEndoCockpitPublicIdV0(`endo.event.pi-entry.${"a".repeat(48)}`)).toBe(true);
		const timeline = timelineOf(events);
		expect(validateEndoCockpitSessionTimelineV0(timeline)).not.toBeNull();
		const forged = mutated(timeline, (t) => {
			t.entries[0].fields.fingerprintId.value = victim.id;
		});
		expect(validateEndoCockpitSessionTimelineV0(forged)).toBeNull();
		const { identity } = everything();
		const forgedIdentity = mutated(identity, (i) => {
			i.current.id = victim.id;
			i.current.ref.id = victim.id;
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forgedIdentity)).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// P2: ineligible usage
// ---------------------------------------------------------------------------------------------------------------

describe("usage that is not presented is withheld (P2)", () => {
	const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7 };
	const entry = (payload: Record<string, unknown>) => timelineOf([event("message.completed", payload)]).entries[0]!;

	it("counts usage on a user message as withheld; an assistant message presents it whole", () => {
		const user = entry({ role: "user", usage });
		const assistant = entry({ role: "assistant", usage });
		expect(user.usage).toBeNull();
		expect(assistant.usage).toMatchObject({ basis: "reported" });
		expect(user.withheldFields).toBe(assistant.withheldFields + 1);
		// A user message without usage withholds nothing more than the same message with none.
		expect(entry({ role: "user" }).withheldFields).toBe(user.withheldFields - 1);
	});

	it("counts malformed, unavailable and over-wide usage as withheld too", () => {
		const good = entry({ role: "assistant", usage });
		expect(good.usage).toMatchObject({ basis: "reported" });
		const wide = entry({ role: "assistant", usage: { ...usage, secret: 1 } });
		const malformed = entry({ role: "assistant", usage: { input: "x" } });
		expect(wide.withheldFields).toBe(good.withheldFields + 1);
		expect(malformed.usage).toMatchObject({ basis: "unavailable" });
		expect(malformed.withheldFields).toBe(good.withheldFields + 1);
		// Absent usage: the key does not exist, so nothing is withheld on its account.
		expect(entry({ role: "assistant" }).withheldFields).toBe(good.withheldFields);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// P2: ids unique across kinds
// ---------------------------------------------------------------------------------------------------------------

describe("record ids are unique across kinds (P2)", () => {
	/** The specimen with the evidence record at `at` (default: the first) carrying `id`. */
	function withEvidenceId(id: string, at = 0) {
		const records = specimenRecords();
		const evidence = records.evidence.map((item, index) => (index === at ? { ...item, id } : item));
		// The state cites evidence by id: keep its citations pointing at the originals.
		return { ...records, evidence };
	}

	it("notes an evidence record that reuses a fingerprint id, referencing the discarded record", () => {
		const records = specimenRecords();
		const reused = withEvidenceId(records.fingerprint[0]!.id);
		const projected = projectEndoCockpitCapabilityStateV0(registryInput(reused as never) as never, TEST_KEY);
		const notes = projected.notes.filter((note) => note.code === "duplicate-record-id");
		expect(notes).toHaveLength(1);
		expect(notes[0]!.refs).toEqual([
			{
				domain: "harness-registry",
				attachment: "pi.default",
				kind: "evidence",
				index: 0,
				id: publicIdV0(records.fingerprint[0]!.id),
			},
		]);
		// The projector cannot know append order across kinds, so it keeps the first record in kind order and says what it
		// set aside; the source's watermark stays coherent because the repeat is not the last record of its kind.
		expect(validateEndoCockpitCapabilityStateV0(projected)).not.toBeNull();
	});

	it("refuses, as a violated precondition, a source whose watermark ends two kinds at one id", () => {
		const records = specimenRecords();
		const last = records.evidence.length - 1;
		expect(last).toBeGreaterThan(0);
		// The repeat is the LAST evidence record, so the watermark itself names one id as the last of two kinds. That source
		// cannot have come from a registry (ids are unique across kinds), and no replacement id or position is invented for it.
		const reused = withEvidenceId(records.fingerprint[0]!.id, last);
		expect(() => projectEndoCockpitCapabilityStateV0(registryInput(reused as never) as never, TEST_KEY)).toThrow(
			TypeError,
		);
		expect(() => projectEndoCockpitRuntimeIdentityV0(registryInput(reused as never) as never, TEST_KEY)).toThrow(
			TypeError,
		);
	});

	it("the same collision is judged by the projection that does not present the later kind", () => {
		const records = specimenRecords();
		const reused = withEvidenceId(records.fingerprint[0]!.id);
		const identity = projectEndoCockpitRuntimeIdentityV0(registryInput(reused as never) as never, TEST_KEY);
		expect(identity.notes.filter((note) => note.code === "duplicate-record-id")).toEqual([]);
		expect(identity.current).not.toBeNull();
	});

	it("keeps the first record in kind order across kinds a projection does not present", () => {
		const records = specimenRecords();
		// A change reusing the id of the first evidence record: the change (earlier kind) wins, the evidence record is the repeat.
		const change = changeRecord({ id: records.evidence[0]!.id });
		const combined = { ...records, change: [change] };
		const capabilities = projectEndoCockpitCapabilityStateV0(registryInput(combined as never) as never, TEST_KEY);
		expect(capabilities.notes.map((note) => note.code)).toEqual(["duplicate-record-id"]);
		const identity = projectEndoCockpitRuntimeIdentityV0(registryInput(combined as never) as never, TEST_KEY);
		expect(identity.notes.filter((note) => note.code === "duplicate-record-id")).toEqual([]);
		expect(identity.lastChange).not.toBeNull();
	});

	it("notes a repeat within one kind, leaves unique ids and states alone, and holds no state between calls", () => {
		const records = specimenRecords();
		const input = registryInput(records as never);
		const first = projectEndoCockpitCapabilityStateV0(input as never, TEST_KEY);
		expect(first.notes.filter((note) => note.code === "duplicate-record-id")).toEqual([]);
		// Two capability states carry no id: never a duplicate of each other.
		const twoStates = { ...records, state: [records.state[0]!, records.state[0]!] };
		const withStates = projectEndoCockpitCapabilityStateV0(registryInput(twoStates as never) as never, TEST_KEY);
		expect(withStates.notes.filter((note) => note.code === "duplicate-record-id")).toEqual([]);
		// A repeat within the evidence kind is noted once per repeat.
		const repeated = { ...records, evidence: [...records.evidence, records.evidence[0]!] };
		const projected = projectEndoCockpitCapabilityStateV0(registryInput(repeated as never) as never, TEST_KEY);
		expect(projected.notes.filter((note) => note.code === "duplicate-record-id")).toHaveLength(1);
		// And the earlier call left nothing behind.
		expect(JSON.stringify(projectEndoCockpitCapabilityStateV0(input as never, TEST_KEY))).toBe(JSON.stringify(first));
	});
});

// ---------------------------------------------------------------------------------------------------------------
// P2: a window's first position
// ---------------------------------------------------------------------------------------------------------------

describe("the first position of a nonempty window is presented (P2)", () => {
	const three = [event("agent.prompt-accepted"), event("agent.prompt-accepted"), event("agent.prompt-accepted")];
	const base = (): EndoCockpitSessionTimelineV0 =>
		projectEndoCockpitSessionTimelineV0(
			{ source: logSource(3, three[2]!.id), afterSequence: 0, events: stored(three.slice(0, 3)) },
			TEST_KEY,
		);

	it("refuses a one-position window that ignores its only position as a duplicate", () => {
		const forged = mutated(base(), (t) => {
			t.entries = [];
			t.sessions = [];
			t.window = { afterSequence: 0, nextAfterSequence: 1, hasMore: true };
			t.duplicatesIgnored = 1;
		});
		expect(validateEndoCockpitSessionTimelineV0(forged)).toBeNull();
	});

	it("refuses an initial gap before the first presented entry", () => {
		const forged = mutated(base(), (t) => {
			t.entries = [t.entries[1]];
			t.sessions = [];
			t.window = { afterSequence: 0, nextAfterSequence: 2, hasMore: true };
			t.duplicatesIgnored = 1;
		});
		// The sessions summary is judged separately; isolate the rule by also rebuilding it.
		forged.sessions = [
			{ sessionId: "endo.session.test.one", firstStorageSequence: 2, lastStorageSequence: 2, entries: 1 },
		];
		expect(validateEndoCockpitSessionTimelineV0(forged)).toBeNull();
	});

	it("accepts a duplicate after the first position, from the projector, and empty or past-the-end windows", () => {
		const repeated = [three[0]!, three[1]!, three[0]!];
		const projected = projectEndoCockpitSessionTimelineV0(
			{ source: logSource(3, three[0]!.id), afterSequence: 0, events: stored(repeated) },
			TEST_KEY,
		);
		expect(projected.duplicatesIgnored).toBe(1);
		expect(projected.entries[0]!.storageSequence).toBe(1);
		expect(validateEndoCockpitSessionTimelineV0(projected)).not.toBeNull();
		const past = projectEndoCockpitSessionTimelineV0(
			{ source: logSource(2, three[1]!.id), afterSequence: 5, events: [] },
			TEST_KEY,
		);
		expect(past.entries).toEqual([]);
		expect(validateEndoCockpitSessionTimelineV0(past)).not.toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(base())).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// P2: discarded-record notes name their record
// ---------------------------------------------------------------------------------------------------------------

describe("a foreign or repeated record note names exactly that record (P2)", () => {
	function withNote(code: "foreign-attachment-record" | "duplicate-record-id", refs: unknown[]) {
		const records = specimenRecords();
		const projected = projectEndoCockpitCapabilityStateV0(registryInput(records as never) as never, TEST_KEY);
		return mutated(projected, (p) => {
			p.notes.push({ code, refs });
		});
	}
	const ref = (kind: string, index = 0, id: string | null = null) => ({
		domain: "harness-registry",
		attachment: "pi.default",
		kind,
		index,
		id,
	});
	const records = specimenRecords();
	// An evidence record the projection does not present (and not the last, whose id the watermark names).
	const presentedEvidence = new Set(
		projectEndoCockpitCapabilityStateV0(registryInput(records as never) as never, TEST_KEY).capabilities.map(
			(view) => (view.evidence?.ref as { index: number } | undefined)?.index,
		),
	);
	const omittedIndex = records.evidence.findIndex(
		(_, at) => at < records.evidence.length - 1 && !presentedEvidence.has(at),
	);
	const fingerprintRef = ref("evidence", omittedIndex, publicIdV0("endo.evidence.test-omitted.1"));

	for (const code of ["foreign-attachment-record", "duplicate-record-id"] as const) {
		it(`${code}: zero references are refused, one valid reference is accepted, two are refused`, () => {
			expect(validateEndoCockpitCapabilityStateV0(withNote(code, []))).toBeNull();
			expect(validateEndoCockpitCapabilityStateV0(withNote(code, [fingerprintRef]))).not.toBeNull();
			expect(validateEndoCockpitCapabilityStateV0(withNote(code, [fingerprintRef, fingerprintRef]))).toBeNull();
		});

		it(`${code}: a reference of a kind the projection does not clean is refused`, () => {
			const changeRef = ref("change", 0, publicIdV0("endo.evidence.pi-change.1"));
			expect(validateEndoCockpitCapabilityStateV0(withNote(code, [changeRef]))).toBeNull();
		});
	}

	it("a repeated id needs an id to repeat, and a source that cannot be projected still carries no references", () => {
		const stateRef = ref("state", 0, null);
		expect(validateEndoCockpitCapabilityStateV0(withNote("duplicate-record-id", [stateRef]))).toBeNull();
		const empty = registryInput({ fingerprint: [], change: [], evidence: [], state: [], notification: [] });
		const absent = projectEndoCockpitCapabilityStateV0(
			{
				source: {
					...empty.source,
					condition: { ...CLEAN, state: "absent" },
					watermark: { ...empty.source.watermark, contentDigest: sha256HexV0(canonicalEndoJsonV0({})) },
				},
				records: null,
			} as never,
			TEST_KEY,
		);
		expect(absent.notes).toEqual([{ code: "source-not-projectable", refs: [] }]);
		expect(validateEndoCockpitCapabilityStateV0(absent)).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Review round 12: relationships between public values that describe one fact
// ---------------------------------------------------------------------------------------------------------------

describe("withheldFields is at least what the presented fields prove (P2)", () => {
	const entryOf = (kind: string, payload: Record<string, unknown>) => timelineOf([event(kind, payload)]);
	const withCount = (timeline: EndoCockpitSessionTimelineV0, count: number) =>
		mutated(timeline, (t) => {
			t.entries[0].withheldFields = count;
		});
	const valid = (timeline: EndoCockpitSessionTimelineV0) => validateEndoCockpitSessionTimelineV0(timeline) !== null;

	it("two fields from different nested parents prove two withheld keys", () => {
		const t = entryOf("session.entry-observed", {
			entryType: "message",
			source: { entryId: "entry-1" },
			details: { role: "user" },
		});
		expect(t.entries[0]!.fields.entryId).toMatchObject({ value: "entry-1" });
		expect(t.entries[0]!.fields.role).toMatchObject({ value: "user" });
		expect(t.entries[0]!.withheldFields).toBe(2);
		expect(valid(withCount(t, 0))).toBe(false);
		expect(valid(withCount(t, 1))).toBe(false);
		expect(valid(withCount(t, 2))).toBe(true);
		expect(valid(withCount(t, 7))).toBe(true);
	});

	it("nested fields sharing one parent prove one key, not one per field", () => {
		const t = entryOf("session.entry-observed", {
			entryType: "message",
			details: { role: "assistant", stopReason: "stop" },
		});
		expect(t.entries[0]!.withheldFields).toBe(1);
		expect(valid(withCount(t, 0))).toBe(false);
		expect(valid(withCount(t, 1))).toBe(true);
	});

	it("a value the boundary replaced proves its whole key was left out", () => {
		const t = entryOf("harness.attached", {
			instance: "sk-aaaaaaaaaaaaaaaaaaaaaaaa",
			fingerprintId: "endo.evidence.x.1",
		});
		expect(t.entries[0]!.fields.instance).toMatchObject({ basis: "unavailable" });
		expect(valid(withCount(t, 0))).toBe(false);
		expect(valid(withCount(t, t.entries[0]!.withheldFields))).toBe(true);
	});

	it("a runtime-reported gap is presented whole and proves nothing; neither does missing or presented usage", () => {
		const gap = entryOf("lifecycle.turn-completed", {
			turn: 1,
			stopReason: { status: "UNAVAILABLE", reason: "not reported" },
		});
		expect(gap.entries[0]!.fields.stopReason).toEqual({ basis: "unavailable", reason: "not reported" });
		expect(valid(withCount(gap, 0))).toBe(true);
		const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7 };
		for (const payload of [
			{ role: "user" },
			{ role: "assistant" },
			{ role: "assistant", usage },
			{ role: "user", usage },
		])
			expect(valid(withCount(entryOf("message.completed", payload), 0)), JSON.stringify(payload)).toBe(true);
	});
});

describe("a registry watermark ends no two kinds at one id (P2)", () => {
	const records = {
		...specimenRecords(),
		fingerprint: [fingerprintAt(VICTIM_PATH), fingerprintAt("/opt/pi")],
		change: [changeRecord()],
		notification: [notificationRecord()],
	};
	const identity = projectEndoCockpitRuntimeIdentityV0(registryInput(records as never) as never, TEST_KEY);
	const capabilities = projectEndoCockpitCapabilityStateV0(registryInput(records as never) as never, TEST_KEY);

	it("accepts the unique watermark, and null last ids repeat freely (empty kinds, the state kind)", () => {
		const lasts = Object.values(identity.source.watermark!.lastIds).filter((id) => id !== null);
		expect(new Set(lasts).size).toBe(lasts.length);
		expect(Object.values(identity.source.watermark!.lastIds).filter((id) => id === null).length).toBeGreaterThan(0);
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
	});

	it("accepts several empty kinds and an absent registry (their null last ids repeat)", () => {
		const empty = registryInput({ fingerprint: [], change: [], evidence: [], state: [], notification: [] } as never);
		const nulls = Object.values(empty.source.watermark.lastIds).filter((id) => id === null);
		expect(nulls.length).toBe(5);
		const absent = projectEndoCockpitRuntimeIdentityV0(
			{
				source: {
					...empty.source,
					condition: { ...CLEAN, state: "absent" },
					watermark: { ...empty.source.watermark, contentDigest: sha256HexV0(canonicalEndoJsonV0({})) },
				},
				records: null,
			} as never,
			TEST_KEY,
		);
		expect(validateEndoCockpitRuntimeIdentityV0(absent)).not.toBeNull();
		const emptied = projectEndoCockpitRuntimeIdentityV0(
			{ ...empty, source: { ...empty.source, condition: { ...CLEAN, state: "empty" } } } as never,
			TEST_KEY,
		);
		expect(validateEndoCockpitRuntimeIdentityV0(emptied)).not.toBeNull();
	});

	it("rejects one id as the last of two kinds, in either projection", () => {
		const forgedIdentity = mutated(identity, (i) => {
			i.source.watermark.lastIds.evidence = i.source.watermark.lastIds.fingerprint;
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forgedIdentity)).toBeNull();
		const forgedCapabilities = mutated(capabilities, (c) => {
			c.source.watermark.lastIds.notification = c.source.watermark.lastIds.change;
		});
		expect(validateEndoCockpitCapabilityStateV0(forgedCapabilities)).toBeNull();
	});
});

describe("a record a cleaning note discards is not also a view (P2)", () => {
	const records = {
		...specimenRecords(),
		fingerprint: [fingerprintAt(VICTIM_PATH), fingerprintAt("/opt/pi")],
		change: [changeRecord()],
		notification: [notificationRecord()],
	};
	const identity = projectEndoCockpitRuntimeIdentityV0(registryInput(records as never) as never, TEST_KEY);
	const capabilities = projectEndoCockpitCapabilityStateV0(registryInput(records as never) as never, TEST_KEY);
	const withNote = <T>(value: T, code: string, ref: unknown) =>
		mutated(value, (v) => {
			v.notes.push({ code, refs: [structuredClone(ref)] });
		});

	const views: [string, () => unknown][] = [
		["current", () => identity.current!.ref],
		["previousDifferent", () => identity.previousDifferent!.ref],
		["lastChange", () => identity.lastChange!.ref],
		["lastNotification", () => identity.lastNotification!.ref],
	];
	for (const code of ["foreign-attachment-record", "duplicate-record-id"]) {
		for (const [name, ref] of views)
			it(`${code} naming the presented ${name} is refused`, () => {
				expect(identity[name as "current"]).not.toBeNull();
				expect(validateEndoCockpitRuntimeIdentityV0(withNote(identity, code, ref()))).toBeNull();
			});
		it(`${code} naming the cited evidence is refused`, () => {
			const cited = capabilities.capabilities.find((view) => view.evidence !== null)!;
			expect(validateEndoCockpitCapabilityStateV0(withNote(capabilities, code, cited.evidence!.ref))).toBeNull();
		});
	}

	it("foreign-attachment-record naming the presented state is refused", () => {
		expect(
			validateEndoCockpitCapabilityStateV0(
				withNote(capabilities, "foreign-attachment-record", capabilities.state!.ref),
			),
		).toBeNull();
	});

	it("accepts the same code about an omitted record of the same kind (another index), and unrelated notes", () => {
		// Two changes: the later is presented; the earlier (index 0) is the one the note discards.
		const lone = projectEndoCockpitRuntimeIdentityV0(
			registryInput({ ...specimenRecords(), change: [changeRecord()] } as never) as never,
			TEST_KEY,
		);
		const two = mutated(lone, (i) => {
			i.source.watermark.counts.change = 2;
			i.lastChange.ref.index = 1;
		});
		const omitted = {
			...(lone.lastChange!.ref as RegistryRef),
			index: 0,
			id: `endo.evidence.withheld-${"0".repeat(32)}`,
		};
		expect(validateEndoCockpitRuntimeIdentityV0(two)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withNote(two, "duplicate-record-id", omitted))).not.toBeNull();
		// An equal id at another index is not the presented record: the comparison is by the complete reference.
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				withNote(two, "duplicate-record-id", { ...omitted, id: (lone.lastChange!.ref as RegistryRef).id }),
			),
		).not.toBeNull();
		// The same id at the presented index is the presented record itself.
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				withNote(two, "duplicate-record-id", {
					...omitted,
					index: 1,
					id: (lone.lastChange!.ref as RegistryRef).id,
				}),
			),
		).toBeNull();
		// A note that is not a cleaning note may cite a presented record.
		const stale = withNote(identity, "latest-change-not-for-latest-fingerprint", identity.current!.ref);
		expect(stale.notes.at(-1)?.code).toBe("latest-change-not-for-latest-fingerprint");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Review round 13: required notes and limits, the latest kept record, shared evidence
// ---------------------------------------------------------------------------------------------------------------

describe("a notice with no change record to name requires its note (P2)", () => {
	const project = (records: unknown) =>
		projectEndoCockpitRuntimeIdentityV0(registryInput(records as never) as never, TEST_KEY);
	const base = specimenRecords();
	const zero = project({ ...base, notification: [notificationRecord()] });
	const noteOf = (identity: typeof zero) => identity.notes.filter((n) => n.code === "notification-change-missing");

	it("accepts the projector's output for zero changes, and rejects its note being removed, mis-referenced or repeated", () => {
		expect(noteOf(zero)).toHaveLength(1);
		expect(validateEndoCockpitRuntimeIdentityV0(zero)).not.toBeNull();
		const without = mutated(zero, (i) => {
			i.notes = i.notes.filter((n: { code: string }) => n.code !== "notification-change-missing");
		});
		expect(validateEndoCockpitRuntimeIdentityV0(without)).toBeNull();
		const wrongRef = mutated(zero, (i) => {
			i.notes.find((n: { code: string }) => n.code === "notification-change-missing").refs[0].index = 5;
		});
		expect(validateEndoCockpitRuntimeIdentityV0(wrongRef)).toBeNull();
		const twice = mutated(zero, (i) => {
			i.notes.push(structuredClone(i.notes.find((n: { code: string }) => n.code === "notification-change-missing")));
		});
		expect(validateEndoCockpitRuntimeIdentityV0(twice)).toBeNull();
	});

	it("does not require it when a notice is absent, or when changes exist (their list is not embedded)", () => {
		const none = project(base);
		expect(noteOf(none)).toHaveLength(0);
		expect(validateEndoCockpitRuntimeIdentityV0(none)).not.toBeNull();
		const matching = project({ ...base, change: [changeRecord()], notification: [notificationRecord()] });
		expect(noteOf(matching)).toHaveLength(0);
		expect(validateEndoCockpitRuntimeIdentityV0(matching)).not.toBeNull();
		const missing = project({
			...base,
			change: [changeRecord()],
			notification: [notificationRecord({ changeId: "endo.evidence.test-change.2" })],
		});
		expect(noteOf(missing)).toHaveLength(1);
		expect(validateEndoCockpitRuntimeIdentityV0(missing)).not.toBeNull();
		// With changes recorded, whether the named one is among them is not decidable from the view: no note is demanded.
		const dropped = mutated(missing, (i) => {
			i.notes = i.notes.filter((n: { code: string }) => n.code !== "notification-change-missing");
		});
		expect(validateEndoCockpitRuntimeIdentityV0(dropped)).not.toBeNull();
	});
});

describe("a state naming a fingerprint that cannot exist requires its limit (P2)", () => {
	const base = specimenRecords();
	const project = (records: unknown) =>
		projectEndoCockpitCapabilityStateV0(registryInput(records as never) as never, TEST_KEY);
	const limitCodes = (view: { limits: { code: string }[] }) => view.limits.map((l) => l.code);
	const empty = project({ ...base, fingerprint: [] });
	const admittedAt = empty.capabilities.findIndex((c) => c.status !== "unverified");

	it("accepts the projector's output with no fingerprint recorded, and rejects the limit omitted or mis-referenced", () => {
		expect(base.state[0]!.fingerprintId).not.toBeNull();
		expect(limitCodes(empty.capabilities[admittedAt]!)).toContain("state-fingerprint-not-recorded");
		expect(limitCodes(empty.capabilities[admittedAt]!)).toContain("state-without-fingerprint");
		expect(validateEndoCockpitCapabilityStateV0(empty)).not.toBeNull();
		const omitted = mutated(empty, (c) => {
			c.capabilities[admittedAt].limits = c.capabilities[admittedAt].limits.filter(
				(l: { code: string }) => l.code !== "state-fingerprint-not-recorded",
			);
		});
		expect(validateEndoCockpitCapabilityStateV0(omitted)).toBeNull();
		const wrongRef = mutated(empty, (c) => {
			const limit = c.capabilities[admittedAt].limits.find(
				(l: { code: string }) => l.code === "state-fingerprint-not-recorded",
			);
			limit.refs = [];
		});
		expect(validateEndoCockpitCapabilityStateV0(wrongRef)).toBeNull();
	});

	it("does not require it for a nonempty history (an older record may exist), for a null fingerprint, or unverified capabilities", () => {
		const older = { ...fingerprintAt("/opt/pi") };
		const nonEmpty = project({ ...base, fingerprint: [older] });
		expect(limitCodes(nonEmpty.capabilities[admittedAt]!)).toContain("state-fingerprint-not-recorded");
		const dropped = mutated(nonEmpty, (c) => {
			c.capabilities[admittedAt].limits = c.capabilities[admittedAt].limits.filter(
				(l: { code: string }) => l.code !== "state-fingerprint-not-recorded",
			);
		});
		expect(validateEndoCockpitCapabilityStateV0(dropped)).not.toBeNull();
		// (A null fingerprint with an admitted capability is not a state the durable contract allows; the round-14 tests refuse it.)
		const unverifiedOnly = {
			...base.state[0]!,
			fingerprintId: null,
			capabilities: base.state[0]!.capabilities.map((c) => ({
				...c,
				status: "unverified",
				classification: null,
				evidenceId: null,
			})),
		};
		const nullNamed = project({ ...base, fingerprint: [], state: [unverifiedOnly] });
		for (const view of nullNamed.capabilities)
			expect(limitCodes(view)).not.toContain("state-fingerprint-not-recorded");
		expect(validateEndoCockpitCapabilityStateV0(nullNamed)).not.toBeNull();
		for (const view of empty.capabilities.filter((c) => c.status === "unverified")) expect(view.limits).toEqual([]);
	});
});

type Fp = ReturnType<typeof fingerprintAt>;
describe("the latest record is the latest one kept (P2)", () => {
	const fps = ["/a/pi", "/b/pi", "/c/pi", "/d/pi"].map(fingerprintAt);
	const foreign = (fp: (typeof fps)[number]) => ({ ...fp, attachment: "other.attachment" });
	const identityOf = (list: unknown[]) =>
		projectEndoCockpitRuntimeIdentityV0(
			registryInput({ ...specimenRecords(), fingerprint: list } as never) as never,
			TEST_KEY,
		);
	const currentIndex = (i: { current: { ref: { index: number } } | null }) => i.current?.ref.index ?? null;
	/** The identity with `current` moved to position `to`: every reference to the old current record follows it. */
	const forgeCurrent = (identity: ReturnType<typeof identityOf>, to: number, id: string) =>
		mutated(identity, (i) => {
			i.current ??= structuredClone(identityOf(fps).current);
			const before = JSON.stringify(i.current.ref);
			const after = { ...i.current.ref, index: to, id };
			const follow = (node: any): void => {
				if (typeof node !== "object" || node === null) return;
				for (const key of Object.keys(node)) {
					if (JSON.stringify(node[key]) === before) node[key] = structuredClone(after);
					else follow(node[key]);
				}
			};
			follow(i);
			i.current.ref = after;
			i.current.id = id;
			// No earlier-different observation is kept, so the order rule between the two cannot be what refuses.
			i.previousDifferent = null;
			i.notes = i.notes.filter((n: { code: string }) => n.code !== "no-fingerprint-recorded");
		});

	it("accepts the projector's output when the first, middle or last record is discarded, or several, or all", () => {
		const [f0, f1, f2, f3] = fps as [Fp, Fp, Fp, Fp];
		const cases: [string, unknown[], number | null][] = [
			["undisturbed", fps, 3],
			["first discarded", [foreign(f0), f1, f2, f3], 3],
			["middle discarded", [f0, foreign(f1), f2, f3], 3],
			["last discarded", [f0, f1, f2, foreign(f3)], 2],
			["last two discarded", [f0, f1, foreign(f2), foreign(f3)], 1],
			["all discarded", fps.map(foreign), null],
		];
		for (const [name, list, expected] of cases) {
			const identity = identityOf(list);
			expect(currentIndex(identity as never), name).toBe(expected);
			expect(validateEndoCockpitRuntimeIdentityV0(identity), name).not.toBeNull();
		}
	});

	const [f0, f1, f2, f3] = fps as [Fp, Fp, Fp, Fp];
	const refused = (list: unknown[], to: number) =>
		expect(
			validateEndoCockpitRuntimeIdentityV0(forgeCurrent(identityOf(list), to, publicIdV0(fps[to]!.id))),
		).toBeNull();
	// Codex's scenario: position 0 discarded, the tail kept - presenting position 1 is impossible.
	it("refuses position 1 as current when position 0 was discarded and the tail kept", () => {
		refused([foreign(f0), f1, f2, f3], 1);
	});
	it("refuses a non-latest current when a middle position was discarded", () => {
		refused([f0, foreign(f1), f2, f3], 2);
	});
	it("refuses position 0, and the discarded tail, when the last was discarded", () => {
		refused([f0, f1, f2, foreign(f3)], 0);
		refused([f0, f1, f2, foreign(f3)], 3);
	});
	it("refuses position 0 when the last two were discarded (position 1 is the latest kept)", () => {
		refused([f0, f1, foreign(f2), foreign(f3)], 0);
	});
	it("refuses a state's latestFingerprintId of null while a fingerprint is kept", () => {
		const list = [f0, f1, f2, foreign(f3)];
		const state = projectEndoCockpitCapabilityStateV0(
			registryInput({ ...specimenRecords(), fingerprint: list } as never) as never,
			TEST_KEY,
		);
		expect(validateEndoCockpitCapabilityStateV0(state)).not.toBeNull();
		const forged = mutated(state, (c) => {
			c.state.latestFingerprintId = null;
			c.state.currency = "unknown";
			c.notes.push({ code: "state-without-fingerprint", refs: [structuredClone(c.state.ref)] });
			for (const view of c.capabilities)
				if (view.status !== "unverified") {
					view.limits = view.limits.filter((l: { code: string }) => l.code !== "state-not-for-latest-fingerprint");
					view.limits.push({ code: "state-without-fingerprint", refs: [structuredClone(c.state.ref)] });
					view.limits.sort(
						(x: { code: string }, y: { code: string }) =>
							ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(x.code as never) -
							ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(y.code as never),
					);
				}
		});
		expect(validateEndoCockpitCapabilityStateV0(forged)).toBeNull();
	});

	it("refuses any current when every record was discarded", () => {
		refused(fps.map(foreign), 0);
	});
	it("refuses a non-tail current in an undisturbed history", () => {
		refused(fps, 1);
	});
});

describe("capabilities citing one evidence record agree about it (P2)", () => {
	const base = specimenRecords();
	const cap = base.state[0]!.capabilities;
	// The second admitted capability cites the first one's evidence record: legitimate, with its own limits.
	const firstAdmitted = cap.findIndex((c) => c.evidenceId !== null);
	const secondAdmitted = cap.findIndex((c, at) => at > firstAdmitted && c.evidenceId !== null);
	const shared = {
		...base,
		state: [
			{
				...base.state[0]!,
				capabilities: cap.map((c, at) =>
					at === secondAdmitted ? { ...c, evidenceId: cap[firstAdmitted]!.evidenceId } : c,
				),
			},
		],
	};
	const projected = projectEndoCockpitCapabilityStateV0(registryInput(shared as never) as never, TEST_KEY);
	const views = projected.capabilities.filter((c) => c.evidence !== null);
	const a = projected.capabilities.findIndex((c) => c.evidence !== null);
	const b = projected.capabilities.findIndex(
		(c, at) => at > a && c.evidence !== null && c.evidence.id === projected.capabilities[a]!.evidence!.id,
	);
	const _forge = (edit: (second: any, first: any) => void) =>
		mutated(projected, (p) => edit(p.capabilities[b], p.capabilities[a]));

	it("accepts the projector's output, with capability-specific limits that differ", () => {
		expect(views.length).toBeGreaterThan(1);
		expect(b).toBeGreaterThan(a);
		expect(validateEndoCockpitCapabilityStateV0(projected)).not.toBeNull();
		// Different limits from one record are legitimate: the second capability's own check differs from the record's.
		expect(projected.capabilities[b]!.limits.map((l) => l.code)).not.toEqual(
			projected.capabilities[a]!.limits.map((l) => l.code),
		);
	});

	// Each member in its own test. `both` applies the edit to the two citing capabilities (each stays valid alone, with its own
	// limits adjusted where the member feeds one); `one` applies it to the second only. Only the disagreement can refuse `one`.
	const classificationOf = (c: { classification: string | null }) => c.classification;
	const setClassification = (view: any, value: string) => {
		view.evidence.classification = value;
		const differs = view.evidence.classification !== classificationOf(view);
		view.limits = view.limits.filter((l: { code: string }) => l.code !== "evidence-classification-differs");
		if (differs) {
			view.limits.push({ code: "evidence-classification-differs", refs: [view.ref, view.evidence.ref] });
			view.limits.sort(
				(x: { code: string }, y: { code: string }) =>
					ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(x.code as never) -
					ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(y.code as never),
			);
		}
	};
	const members: [string, (view: any) => void][] = [
		[
			"classification",
			(view) =>
				setClassification(
					view,
					ENDO_CONFORMANCE_CLASSIFICATIONS_V0.find(
						(value) =>
							value !== projected.capabilities[a]!.classification &&
							value !== projected.capabilities[b]!.classification,
					)!,
				),
		],
		[
			"check",
			(view) => {
				view.evidence.check.name = "another-check";
			},
		],
		[
			"dependencies",
			(view) => {
				view.evidence.dependencies.adapterVersion = "9.9.9";
			},
		],
		["supporting", (view) => view.evidence.supporting.push("b".repeat(64))],
		["recorded limitations", (view) => view.limitations.push("an extra limitation")],
	];
	for (const [name, edit] of members) {
		it(`${name}: a one-sided difference is refused; the same edit on both is accepted`, () => {
			const both = mutated(projected, (p) => {
				edit(p.capabilities[a]);
				edit(p.capabilities[b]);
			});
			expect(validateEndoCockpitCapabilityStateV0(both)).not.toBeNull();
			const one = mutated(projected, (p) => edit(p.capabilities[b]));
			expect(validateEndoCockpitCapabilityStateV0(one)).toBeNull();
		});
	}

	it("accepts distinct evidence records that differ", () => {
		expect(
			validateEndoCockpitCapabilityStateV0(
				projectEndoCockpitCapabilityStateV0(registryInput(base as never) as never, TEST_KEY),
			),
		).not.toBeNull();
	});
});

describe("required notes and limits when every record of a kind was discarded (P2)", () => {
	const base = specimenRecords();
	it("a notice whose change cannot be found requires its note even when the changes were all discarded", () => {
		const records = {
			...base,
			change: [{ ...changeRecord(), attachment: "other.attachment" }],
			notification: [notificationRecord()],
		};
		const identity = projectEndoCockpitRuntimeIdentityV0(registryInput(records as never) as never, TEST_KEY);
		expect(identity.lastChange).toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		const without = mutated(identity, (i) => {
			i.notes = i.notes.filter((n: { code: string }) => n.code !== "notification-change-missing");
		});
		expect(validateEndoCockpitRuntimeIdentityV0(without)).toBeNull();
	});

	it("a state naming a fingerprint requires its limit even when the fingerprints were all discarded", () => {
		const records = { ...base, fingerprint: [{ ...base.fingerprint[0]!, attachment: "other.attachment" }] };
		const view = projectEndoCockpitCapabilityStateV0(registryInput(records as never) as never, TEST_KEY);
		const at = view.capabilities.findIndex((c) => c.status !== "unverified");
		expect(view.capabilities[at]!.limits.map((l) => l.code)).toContain("state-fingerprint-not-recorded");
		expect(validateEndoCockpitCapabilityStateV0(view)).not.toBeNull();
		const omitted = mutated(view, (c) => {
			c.capabilities[at].limits = c.capabilities[at].limits.filter(
				(l: { code: string }) => l.code !== "state-fingerprint-not-recorded",
			);
		});
		expect(validateEndoCockpitCapabilityStateV0(omitted)).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Review round 14: usage-proven omissions, distinct presented ids, one disposition per record, pagination progress,
// reserved runtime families
// ---------------------------------------------------------------------------------------------------------------

describe("withheldFields counts what usage proves (P2)", () => {
	const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7 };
	const entryOf = (payload: Record<string, unknown>) => timelineOf([event("session.entry-observed", payload)]);
	const withCount = (t: EndoCockpitSessionTimelineV0, n: number) =>
		mutated(t, (x) => {
			x.entries[0].withheldFields = n;
		});
	const ok = (t: EndoCockpitSessionTimelineV0) => validateEndoCockpitSessionTimelineV0(t) !== null;

	it("reported usage proves its carrier: Codex's mutation (1 to 0) is refused", () => {
		const t = entryOf({ entryType: "usage", details: { usage } });
		expect(t.entries[0]!.usage).toMatchObject({ basis: "reported" });
		expect(t.entries[0]!.withheldFields).toBe(1);
		expect(ok(t)).toBe(true);
		expect(ok(withCount(t, 0))).toBe(false);
	});

	it("unavailable usage proves the carrier unless the entry has no details", () => {
		const noUsage = entryOf({ entryType: "usage", details: {} });
		expect(noUsage.entries[0]!.usage).toMatchObject({ basis: "unavailable", reason: "the event records no usage" });
		expect(ok(withCount(noUsage, 0))).toBe(false);
		const malformed = entryOf({ entryType: "usage", details: { usage: { input: "x" } } });
		expect(malformed.entries[0]!.usage).toMatchObject({ reason: "the recorded usage is not in the expected shape" });
		expect(ok(withCount(malformed, 0))).toBe(false);
		for (const details of [undefined, "text"]) {
			const none = entryOf({ entryType: "usage", ...(details === undefined ? {} : { details }) });
			expect(none.entries[0]!.usage).toMatchObject({ reason: "the event records no entry details" });
			expect(ok(withCount(none, 0))).toBe(true);
		}
	});

	it("counts the shared parent once, and a message's own usage key proves nothing", () => {
		const shared = entryOf({ entryType: "message", details: { role: "assistant", usage } });
		expect(shared.entries[0]!.withheldFields).toBe(1);
		expect(ok(withCount(shared, 1))).toBe(true);
		expect(ok(withCount(shared, 0))).toBe(false);
		const message = timelineOf([event("message.completed", { role: "assistant", usage })]);
		expect(
			ok(
				mutated(message, (x) => {
					x.entries[0].withheldFields = 0;
				}),
			),
		).toBe(true);
	});
});

describe("presented records of one registry carry distinct ids (P2)", () => {
	const fpA = fingerprintAt("/a/pi");
	const fpB = fingerprintAt("/b/pi");
	const records = { ...specimenRecords(), fingerprint: [fpA, fpB], change: [changeRecord()] };
	const identity = projectEndoCockpitRuntimeIdentityV0(registryInput(records as never) as never, TEST_KEY);
	const capabilities = projectEndoCockpitCapabilityStateV0(registryInput(records as never) as never, TEST_KEY);
	const base0 = () => specimenRecords();

	/** Give the view at `ref` another id everywhere it is named (its ref, the lists, the watermark when it is the last). */
	const reid = (root: any, view: any, id: string, kind: string) => {
		const before = JSON.stringify(view.ref);
		const after = { ...view.ref, id };
		const follow = (node: any): void => {
			if (typeof node !== "object" || node === null) return;
			for (const key of Object.keys(node)) {
				if (JSON.stringify(node[key]) === before) node[key] = structuredClone(after);
				else follow(node[key]);
			}
		};
		follow(root);
		view.ref = after;
		view.id = id;
		if (view.ref.index === root.source.watermark.counts[kind] - 1) root.source.watermark.lastIds[kind] = id;
	};

	it("accepts distinct ids; refuses an earlier fingerprint and the last change sharing one", () => {
		expect(identity.previousDifferent).not.toBeNull();
		expect(identity.lastChange).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		const forged = mutated(identity, (i) => {
			reid(i, i.lastChange, i.previousDifferent.id, "change");
		});
		expect(forged.lastChange!.id).toBe(forged.previousDifferent!.id);
		expect(validateEndoCockpitRuntimeIdentityV0(forged)).toBeNull();
	});

	const evidenceSetup = () => {
		const counts = capabilities.source.watermark!.counts;
		// Two cited records that are not the last evidence record, so the watermark's last id is not what a forgery collides with.
		const usable = capabilities.capabilities.flatMap((c, at) =>
			c.evidence !== null && (c.evidence.ref as { index: number }).index < counts.evidence - 1 ? [at] : [],
		);
		expect(usable.length).toBeGreaterThan(1);
		const [first, second] = usable as [number, number];
		return { first, second };
	};

	it("accepts the projector's capabilities, whose cited evidence ids are distinct", () => {
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
	});

	it("refuses two different cited evidence records sharing an id", () => {
		const { first, second } = evidenceSetup();
		const twin = mutated(capabilities, (c) => {
			reid(c, c.capabilities[second].evidence, c.capabilities[first].evidence.id, "evidence");
			c.capabilities[second].evidence.id = c.capabilities[first].evidence.id;
		});
		expect(validateEndoCockpitCapabilityStateV0(twin)).toBeNull();
	});

	it("refuses a cited evidence record sharing the id of the latest fingerprint", () => {
		const { first } = evidenceSetup();
		const named = mutated(capabilities, (c) => {
			reid(c, c.capabilities[first].evidence, c.state.latestFingerprintId, "evidence");
		});
		expect(validateEndoCockpitCapabilityStateV0(named)).toBeNull();
	});

	it("does not refuse a state that merely names the id of a cited evidence record (a reference, not a presented record)", () => {
		const cited = base0().state[0]!.capabilities.find((c) => c.evidenceId !== null)!.evidenceId!;
		const odd = { ...base0(), state: [{ ...base0().state[0]!, fingerprintId: cited }] };
		const projected = projectEndoCockpitCapabilityStateV0(registryInput(odd as never) as never, TEST_KEY);
		expect(validateEndoCockpitCapabilityStateV0(projected)).not.toBeNull();
	});

	it("the identity and capability views of one snapshot entry present distinct records", () => {
		const { first } = evidenceSetup();
		const timeline = timelineOf([event("agent.prompt-accepted")]);
		const good = {
			schemaVersion: "endo.cockpit-snapshot.v0",
			projectionVersion: "cockpit-snapshot.3",
			consistency: "independent-sources",
			timeline,
			runtimes: [{ identity, capabilities }],
		};
		expect(validateEndoCockpitSnapshotV0(good)).not.toBeNull();
		const forged = mutated(good, (g) => {
			reid(
				g.runtimes[0].capabilities,
				g.runtimes[0].capabilities.capabilities[first].evidence,
				g.runtimes[0].identity.lastChange.id,
				"evidence",
			);
		});
		expect(validateEndoCockpitCapabilityStateV0(forged.runtimes[0]!.capabilities)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(forged)).toBeNull();
	});
});

describe("one cleaning disposition per discarded record (P2)", () => {
	const base = specimenRecords();
	const fp = base.fingerprint[0]!.id;
	const twoReusing = {
		...base,
		evidence: base.evidence.map((item, at) => (at < 2 ? { ...item, id: fp } : item)),
	};
	const projected = projectEndoCockpitCapabilityStateV0(registryInput(twoReusing as never) as never, TEST_KEY);
	const dupes = projected.notes.filter((n) => n.code === "duplicate-record-id");

	it("accepts one note per record, for two positions whose ids are equal", () => {
		expect(dupes).toHaveLength(2);
		expect(dupes[0]!.refs[0]).toMatchObject({ index: 0 });
		expect(dupes[1]!.refs[0]).toMatchObject({ index: 1 });
		expect(dupes[0]!.refs[0]).toMatchObject({ id: (dupes[1]!.refs[0] as { id: string }).id });
		expect(validateEndoCockpitCapabilityStateV0(projected)).not.toBeNull();
	});

	it("refuses the same note again", () => {
		const again = mutated(projected, (p) => {
			p.notes.push(structuredClone(dupes[0]));
		});
		expect(validateEndoCockpitCapabilityStateV0(again)).toBeNull();
	});

	it("refuses another cleaning code for the same position", () => {
		const conflicting = mutated(projected, (p) => {
			p.notes.push({ code: "foreign-attachment-record", refs: structuredClone(dupes[0]!.refs) });
		});
		expect(validateEndoCockpitCapabilityStateV0(conflicting)).toBeNull();
	});
});

describe("a page before the tail advances (P2)", () => {
	const three = [event("agent.prompt-accepted"), event("agent.prompt-accepted"), event("agent.prompt-accepted")];
	const run = (length: number, after: number, events: typeof three) =>
		projectEndoCockpitSessionTimelineV0(
			{
				source: logSource(length, length === 0 ? null : three[length - 1]!.id),
				afterSequence: after,
				events: stored(events, after + 1),
			},
			TEST_KEY,
		);

	it("refuses an empty page with a cursor before the tail in the validator", () => {
		const page = run(3, 0, three.slice(0, 1));
		const stuck = mutated(page, (t) => {
			t.entries = [];
			t.sessions = [];
			t.window = { afterSequence: 0, nextAfterSequence: 0, hasMore: true };
		});
		expect(validateEndoCockpitSessionTimelineV0(stuck)).toBeNull();
	});

	it("makes the direct projector refuse a window that consumes nothing before the tail", () => {
		expect(() => run(3, 0, [])).toThrow(TypeError);
	});

	it("accepts a one-event page, a page to the tail, and empty pages at, past and with no tail", () => {
		expect(validateEndoCockpitSessionTimelineV0(run(3, 0, three.slice(0, 1)))).not.toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(run(3, 0, three))).not.toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(run(3, 3, []))).not.toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(run(3, 7, []))).not.toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(run(0, 0, []))).not.toBeNull();
		const unopenable = projectEndoCockpitSessionTimelineV0(
			{
				source: {
					domain: "event-log",
					condition: {
						state: "unopenable",
						tornTail: null,
						sealedAt: null,
						error: { kind: "invalid-store", message: "the store could not be opened" },
					},
					watermark: null,
				},
				afterSequence: 0,
				events: [],
			} as never,
			TEST_KEY,
		);
		expect(validateEndoCockpitSessionTimelineV0(unopenable)).not.toBeNull();
	});
});

describe("a runtime family in the reserved namespace is aliased (P2)", () => {
	const reserved = `withheld-${"a".repeat(32)}`;
	const identityFor = (runtime: string, key = TEST_KEY) => {
		const records = specimenRecords();
		const input = registryInput(
			{ ...records, fingerprint: [{ ...records.fingerprint[0]!, runtime }] } as never,
			key.keyId,
			key,
		);
		return projectEndoCockpitRuntimeIdentityV0(input as never, key);
	};
	const familyOf = (i: ReturnType<typeof identityFor>) => (i.runtime.basis === "observed" ? i.runtime.value : null);

	it("keeps ordinary families, aliases reserved segments (also within a dotted name) and still withholds sensitive text", () => {
		expect(familyOf(identityFor("pi"))).toBe("pi");
		for (const runtime of [reserved, `acp.${reserved}.v2`]) {
			const identity = identityFor(runtime);
			const alias = cockpitAliasesV0(TEST_KEY).kind(runtime);
			expect(familyOf(identity)).toBe(alias);
			expect(alias).not.toBe(runtime);
			expect(alias).toMatch(/^withheld-[0-9a-f]{32}$/);
			expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
			expect(JSON.stringify(identityFor(runtime))).toBe(JSON.stringify(identity));
			expect(familyOf(identityFor(runtime, OTHER_KEY))).not.toBe(alias);
		}
		expect(identityFor("/home/alice/pi").runtime).toMatchObject({ basis: "unavailable" });
	});
});

describe("a lifecycle runtime field in the reserved namespace is withheld (P2)", () => {
	const runtimeField = (runtime: string) =>
		timelineOf([event("lifecycle.session-started", { runtime, instance: "i-1" })]);

	it("shows an ordinary family as written and withholds a reserved one, and the validator agrees", () => {
		const ordinary = runtimeField("pi");
		expect(ordinary.entries[0]!.fields.runtime).toEqual({ basis: "observed", value: "pi" });
		const reserved = runtimeField(`acp.withheld-${"b".repeat(32)}`);
		expect(reserved.entries[0]!.fields.runtime).toMatchObject({ basis: "unavailable" });
		expect(validateEndoCockpitSessionTimelineV0(reserved)).not.toBeNull();
		const forged = mutated(ordinary, (t) => {
			t.entries[0].fields.runtime.value = `acp.withheld-${"b".repeat(32)}`;
		});
		expect(validateEndoCockpitSessionTimelineV0(forged)).toBeNull();
	});
});
