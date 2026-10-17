// PR #57 review round 11: fingerprint commitments presented as keyed tokens, ineligible usage counted as withheld, record ids
// unique across kinds, a window's first position presented, and discarded-record notes that name their record.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cockpitAliasesV0 } from "../cockpit/projections/common.ts";
import {
	type EndoCockpitSessionTimelineV0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
} from "../protocol/cockpit.ts";
import { isEndoCockpitContentAddressedIdV0, isEndoCockpitPublicIdV0 } from "../protocol/cockpit-fields.ts";
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
	function withEvidenceId(id: string) {
		const records = specimenRecords();
		const evidence = records.evidence.map((item, index, all) => (index === all.length - 1 ? { ...item, id } : item));
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
				index: records.evidence.length - 1,
				id: publicIdV0(records.fingerprint[0]!.id),
			},
		]);
		// The watermark's last evidence id IS the discarded repeat. The projector cannot know append order across kinds, so it
		// does not certify the registry clean: it keeps the first record in kind order and says what it set aside.
		expect(projected.source.watermark!.lastIds.evidence).toBe(publicIdV0(records.fingerprint[0]!.id));
		expect(validateEndoCockpitCapabilityStateV0(projected)).not.toBeNull();
	});

	it("the same collision is judged the same way by the projection that does not present the later kind", () => {
		const records = specimenRecords();
		const reused = withEvidenceId(records.fingerprint[0]!.id);
		const identity = projectEndoCockpitRuntimeIdentityV0(registryInput(reused as never) as never, TEST_KEY);
		expect(identity.notes.filter((note) => note.code === "duplicate-record-id")).toEqual([]);
		expect(identity.current).not.toBeNull();
	});

	it("keeps the first record in kind order across kinds a projection does not present", () => {
		const records = specimenRecords();
		// A change reusing the id of the last evidence record: the change (earlier kind) wins, the evidence record is the repeat.
		const lastEvidence = records.evidence.at(-1)!;
		const change = changeRecord({ id: lastEvidence.id });
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
	const fingerprintRef = ref("fingerprint", 0, publicIdV0(records.fingerprint[0]!.id));

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
