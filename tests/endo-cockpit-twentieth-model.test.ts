// PR #57 review round 20: bounded model-based checks of the invariants the three findings concern. Each model is simpler than
// the validator and derives its expectation independently of it:
//  - source commitments: small event histories; the expectation is known by CONSTRUCTION (an unmutated input is accepted,
//    every mutation of content, position, key, length or token is refused, a window that cannot be checked is accepted);
//  - duplicate ownership: small registries whose raw records say who owns a repeated id; the owner kinds the wire leaves open
//    are derived by direct enumeration of the consistent owners, and the validator must neither refuse what they leave open nor
//    accept what they close;
//  - runtime families: a "world" fixes the hidden runtime families, the REAL projectors produce the canonical views for it, and
//    a snapshot is PRODUCIBLE exactly when some world generates it. Every producible snapshot must be accepted (no canonical
//    output is refused); one no world generates may be accepted only in a declared cell where the wire does not show the record
//    the relation is about.
// Enumeration is exhaustive over small state spaces: no random source, so every failure reproduces.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { eventLogPrefixDigestV0 } from "../cockpit/projections/common.ts";
import { ENDO_COCKPIT_REGISTRY_KINDS_V0, validateEndoCockpitSnapshotV0 } from "../protocol/cockpit.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import {
	changeRecord,
	completeLogSource,
	ingestAll,
	lifecycleEvents,
	modelPrefixDigest,
	notificationRecord,
	removeTempRoots,
	specimenRecords,
	stored,
	tempRoot,
} from "./cockpit-fixtures.ts";
import { projectEndoCockpitSessionTimelineV0, readEndoCockpitEventLogV0, TEST_KEY } from "./cockpit-keyed.ts";
import {
	aliasOf,
	capabilitiesOf,
	evidenceMatching,
	fingerprintAt,
	foreign,
	identityOf,
	mutated,
	rank,
	snapshotFrom,
} from "./cockpit-registry-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

// ---------------------------------------------------------------------------------------------------------------
// 1. Source commitments
// ---------------------------------------------------------------------------------------------------------------

describe("source commitments: exactly the input the reader's commitment describes is accepted", () => {
	const impostor = endoDigestKeyV0(Buffer.alloc(32, 0x77), "cockpit-fixture", { public: true });
	const log = lifecycleEvents("killed-and-resumed");
	const chainOf = (events: readonly unknown[]) =>
		sha256HexV0(events.map((item) => `${sha256HexV0(canonicalEndoJsonV0(item))}\n`).join(""));
	const token = (length: number, chain: string, key = TEST_KEY) =>
		key.digest({ purpose: "endo.cockpit.event-prefix.v0", length, chain }).value;

	/** Histories: a prefix of a recorded log, and (not a store's, but an input a caller can make) one repeating an id. */
	const histories = [
		{ label: "no events", events: [] as typeof log },
		{ label: "one event", events: log.slice(0, 1) },
		{ label: "two events", events: log.slice(0, 2) },
		{ label: "three events", events: log.slice(0, 3) },
		{
			label: "three events, the last repeating an id",
			events: [...log.slice(0, 2), { ...log[1]!, payload: { other: 1 } }],
		},
	];

	interface Case {
		label: string;
		input: any;
		/** Whether the projector may accept it: known by construction, not by asking the validator. */
		accepted: boolean;
	}

	function casesOf(events: typeof log): Case[] {
		const source = completeLogSource(events, TEST_KEY);
		const whole = { source, afterSequence: 0, events: stored(events) };
		const withDigest = (digest: string | null) => ({
			...whole,
			source: mutated(source, (s) => {
				s.watermark.prefixDigest = digest;
			}),
		});
		const cases: Case[] = [{ label: "as the reader reports it", input: whole, accepted: true }];
		if (events.length === 0)
			return [...cases, { label: "a digest on no events", input: withDigest("a".repeat(64)), accepted: false }];
		events.forEach((_, at) => {
			cases.push({
				label: `payload of event ${at} altered`,
				input: {
					...whole,
					events: mutated(whole.events, (list) => {
						list[at].event.payload = { ...list[at].event.payload, altered: at };
					}),
				},
				accepted: false,
			});
			cases.push({
				label: `time of event ${at} altered`,
				input: {
					...whole,
					events: mutated(whole.events, (list) => {
						list[at].event.at = "2031-01-01T00:00:00Z";
					}),
				},
				accepted: false,
			});
		});
		for (let at = 0; at + 1 < events.length; at += 1) {
			if (canonicalEndoJsonV0(events[at]) === canonicalEndoJsonV0(events[at + 1])) continue;
			cases.push({
				label: `events ${at} and ${at + 1} swapped`,
				input: {
					...whole,
					events: mutated(whole.events, (list) => {
						[list[at].event, list[at + 1].event] = [list[at + 1].event, list[at].event];
					}),
				},
				accepted: false,
			});
		}
		const real = source.watermark!.prefixDigest!;
		const chain = chainOf(events);
		cases.push({
			label: "another key's token",
			input: withDigest(token(events.length, chain, impostor)),
			accepted: false,
		});
		cases.push({ label: "a longer length", input: withDigest(token(events.length + 1, chain)), accepted: false });
		cases.push({ label: "a shorter length", input: withDigest(token(events.length - 1, chain)), accepted: false });
		cases.push({
			label: "the chain of one event fewer",
			input: withDigest(token(events.length, chainOf(events.slice(0, -1)))),
			accepted: false,
		});
		for (const at of [0, 31, 63])
			cases.push({
				label: `hex digit ${at} changed`,
				input: withDigest(`${real.slice(0, at)}${real[at] === "0" ? "1" : "0"}${real.slice(at + 1)}`),
				accepted: false,
			});
		// Windows that cannot be checked: the earlier events, or the later ones, are not supplied. Any digest does.
		const arbitrary = sha256HexV0("not the reader's");
		if (events.length > 1) {
			cases.push({
				label: "a window that stops short of the declared length",
				input: { source: withDigest(arbitrary).source, afterSequence: 0, events: stored(events.slice(0, -1)) },
				accepted: true,
			});
			for (let after = 1; after < events.length; after += 1)
				cases.push({
					label: `a window after ${after}`,
					input: {
						source: withDigest(arbitrary).source,
						afterSequence: after,
						events: stored(events.slice(after), after + 1),
					},
					accepted: true,
				});
		}
		return cases;
	}

	for (const history of histories) {
		it(`${history.label}: accepted exactly when the commitment holds or cannot be checked`, () => {
			const cases = casesOf(history.events);
			expect(cases.length).toBeGreaterThan(1);
			for (const { label, input, accepted } of cases) {
				let thrown: unknown;
				try {
					projectEndoCockpitSessionTimelineV0(input, TEST_KEY);
				} catch (error) {
					thrown = error;
				}
				expect(thrown === undefined, `${history.label}: ${label}`).toBe(accepted);
			}
		});
	}

	it("the reader's commitment, the shared construction and the model are one value for every history a store can hold", () => {
		for (const count of [1, 2, 3, 4, 5]) {
			const events = log.slice(0, count);
			const root = tempRoot();
			ingestAll(root, events);
			const read = readEndoCockpitEventLogV0(root, { limit: 1000 });
			const advertised = read.source.watermark!.prefixDigest;
			expect(advertised).toBe(modelPrefixDigest(events, TEST_KEY));
			expect(advertised).toBe(eventLogPrefixDigestV0(TEST_KEY, events));
			expect(advertised).toBe(token(count, chainOf(events)));
			// The same history under another key is another digest, which does not describe this read.
			expect(eventLogPrefixDigestV0(impostor, events)).not.toBe(advertised);
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Duplicate ownership
// ---------------------------------------------------------------------------------------------------------------

describe("duplicate ownership: the validator decides exactly what the wire leaves no room for", () => {
	const base = specimenRecords();
	const first = base.state[0]!;
	const ENTRIES = first.capabilities.slice(0, 2);
	const fingerprints = [0, 1, 2].map((at) => fingerprintAt(`/own/${at}/pi`));
	const changes = [0, 1, 2].map((at) => changeRecord({ id: `endo.evidence.model-change.${at}` }));
	const CLEANING = ["foreign-attachment-record", "duplicate-record-id"];

	interface Registry {
		fingerprint: number;
		change: number;
		/** The record whose id the first evidence record repeats: `kind:index`. */
		owner: string;
		/** A position set aside as a foreign record (never the owner), or none. */
		foreignAt: string | null;
	}

	const positionsOf = (registry: Pick<Registry, "fingerprint" | "change">) => [
		...Array.from({ length: registry.fingerprint }, (_, at) => `fingerprint:${at}`),
		...Array.from({ length: registry.change }, (_, at) => `change:${at}`),
	];

	function registries(): Registry[] {
		const list: Registry[] = [];
		for (const fingerprint of [2, 3])
			for (const change of [0, 1, 2, 3]) {
				const positions = positionsOf({ fingerprint, change });
				for (const owner of positions)
					for (const foreignAt of [null, ...positions.filter((position) => position !== owner)])
						list.push({ fingerprint, change, owner, foreignAt });
			}
		return list;
	}

	const idOf = (position: string) => {
		const [kind, at] = position.split(":");
		return (kind === "fingerprint" ? fingerprints[Number(at)]!.id : changes[Number(at)]!.id) as string;
	};

	function recordsOf(registry: Registry) {
		const dressed = (position: string, record: object) =>
			registry.foreignAt === position ? foreign(record) : record;
		const fps = fingerprints.slice(0, registry.fingerprint).map((record, at) => dressed(`fingerprint:${at}`, record));
		const chs = changes.slice(0, registry.change).map((record, at) => dressed(`change:${at}`, record));
		const kept = fingerprints
			.slice(0, registry.fingerprint)
			.filter((_, at) => registry.foreignAt !== `fingerprint:${at}`);
		const current = kept.at(-1)!;
		const owned = idOf(registry.owner);
		const cited = new Set(ENTRIES.map((entry) => entry.evidenceId));
		return {
			...base,
			fingerprint: fps,
			change: chs,
			evidence: evidenceMatching(base, current)
				.filter((item) => cited.has(item.id))
				.map((item, at) => (at === 0 ? { ...item, id: owned } : item)),
			state: [{ ...first, fingerprintId: current.id, capabilities: ENTRIES }],
			notification: [notificationRecord({ changeId: owned })],
		};
	}

	/** The kind of the record that owns the repeated id, from the raw records and the cleaner's documented ledger order. */
	function truthOf(registry: Registry): string {
		const seen = new Map<string, string>();
		for (const position of positionsOf(registry)) {
			if (registry.foreignAt === position) continue;
			const id = idOf(position);
			if (!seen.has(id)) seen.set(id, position.split(":")[0]!);
		}
		return seen.get(idOf(registry.owner))!;
	}

	const refsIn = (value: unknown, found: any[] = []): any[] => {
		if (Array.isArray(value)) for (const item of value) refsIn(item, found);
		else if (value !== null && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (record.domain === "harness-registry") found.push(record);
			else for (const item of Object.values(record)) refsIn(item, found);
		}
		return found;
	};

	/**
	 * The kinds that can own the repeated id, by direct enumeration of the owner positions consistent with what the snapshot
	 * shows: an earlier position (in the cleaner's order) that is not shown to be set aside, whose id is not shown to be another,
	 * and, because kept records carry distinct ids, not a second holder of an id some other shown record already carries.
	 */
	function ownerKindsOf(snapshot: any): Set<string> {
		const view = snapshot.runtimes[0];
		const mark = view.identity.source.watermark;
		const notes = [...view.identity.notes, ...view.capabilities.notes];
		const set = notes.filter((note: any) => CLEANING.includes(note.code));
		const discarded = new Set(set.flatMap((note: any) => note.refs.map((ref: any) => `${ref.kind}:${ref.index}`)));
		const duplicate = notes.find((note: any) => note.code === "duplicate-record-id").refs[0];
		const exposed = new Map<string, string>();
		const uncleaned = (notes: any[]) => notes.filter((note: any) => !CLEANING.includes(note.code));
		for (const ref of refsIn({
			identity: { ...view.identity, notes: uncleaned(view.identity.notes) },
			capabilities: { ...view.capabilities, notes: uncleaned(view.capabilities.notes) },
		}))
			if (ref.id !== null) exposed.set(`${ref.kind}:${ref.index}`, ref.id);
		for (const kind of ENDO_COCKPIT_REGISTRY_KINDS_V0) {
			const last = mark.counts[kind] - 1;
			if (mark.lastIds[kind] !== null && last >= 0 && !discarded.has(`${kind}:${last}`))
				exposed.set(`${kind}:${last}`, mark.lastIds[kind]);
		}
		const earlier: string[] = [];
		for (const kind of ENDO_COCKPIT_REGISTRY_KINDS_V0) {
			if (kind === "state") continue;
			const upto = kind === duplicate.kind ? duplicate.index : mark.counts[kind];
			for (let at = 0; at < upto; at += 1) earlier.push(`${kind}:${at}`);
			if (kind === duplicate.kind) break;
		}
		const kinds = new Set<string>();
		for (const position of earlier) {
			if (discarded.has(position)) continue;
			const shown = exposed.get(position);
			const otherHolder = [...exposed].some(([other, id]) => other !== position && id === duplicate.id);
			if (shown === duplicate.id || (shown === undefined && !otherHolder)) kinds.add(position.split(":")[0]!);
		}
		return kinds;
	}

	const toggled = (snapshot: any, present: boolean) =>
		mutated(snapshot, (x) => {
			const identity = x.runtimes[0].identity;
			identity.notes = identity.notes.filter(
				(note: { code: string }) => note.code !== "notification-change-missing",
			);
			if (present)
				identity.notes.push({
					code: "notification-change-missing",
					refs: [structuredClone(identity.lastNotification.ref)],
				});
		});

	it("accepts every canonical snapshot, and refuses a forged missing-change diagnostic exactly when the owner's kind is decided", () => {
		let checked = 0;
		const decided = { change: 0, other: 0, open: 0 };
		for (const registry of registries()) {
			const label = JSON.stringify(registry);
			const records = recordsOf(registry);
			const snapshot = snapshotFrom(identityOf(records), capabilitiesOf(records));
			const truth = truthOf(registry);
			const missing = (s: any) =>
				s.runtimes[0].identity.notes.some((note: { code: string }) => note.code === "notification-change-missing");
			// The harness itself: the projectors say what the raw records say.
			expect(missing(snapshot), label).toBe(truth !== "change");
			expect(
				snapshot.runtimes[0].capabilities.notes.some((n: { code: string }) => n.code === "duplicate-record-id"),
				label,
			).toBe(true);
			// Soundness: a canonical output is never refused.
			expect(validateEndoCockpitSnapshotV0(snapshot), label).not.toBeNull();
			const kinds = ownerKindsOf(snapshot);
			// The enumeration is sound against the raw records: the true owner's kind is among the possible ones.
			expect(kinds.has(truth), label).toBe(true);
			const verdict = (present: boolean) => validateEndoCockpitSnapshotV0(toggled(snapshot, present)) !== null;
			if (kinds.size === 1 && kinds.has("change")) {
				// Only a change can own it: a note saying the notice's change is missing is false.
				expect(verdict(true), `${label}: forged missing note`).toBe(false);
				expect(verdict(false), label).toBe(true);
				decided.change += 1;
			} else if (!kinds.has("change")) {
				// No change can own it: the notice's change is missing, and a snapshot without the note is false.
				expect(verdict(false), `${label}: forged absent note`).toBe(false);
				expect(verdict(true), label).toBe(true);
				decided.other += 1;
			} else {
				// A change and another kind both could: nothing is decided, and both diagnostics are admissible.
				expect(verdict(true), `${label}: open, note present`).toBe(true);
				expect(verdict(false), `${label}: open, note absent`).toBe(true);
				decided.open += 1;
			}
			checked += 1;
		}
		// Non-vacuous: every outcome of the enumeration occurs.
		expect(checked).toBeGreaterThan(100);
		expect(decided.change).toBeGreaterThan(0);
		expect(decided.other).toBeGreaterThan(0);
		expect(decided.open).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Runtime families: the relation between the state's fingerprint, the latest fingerprint, the state and the evidence
// ---------------------------------------------------------------------------------------------------------------

const FAMILIES = ["pi", "acp", "zed"] as const;
type Family = (typeof FAMILIES)[number];

const base = specimenRecords();
const first = base.state[0]!;
const NAMES = ["a", "b", "c", "d"] as const;
type Name = (typeof NAMES)[number];
/** A fingerprint with a FIXED id (so the same skeleton is the same records in every world) and a chosen runtime family. */
const fp = (name: Name, runtime: Family) => ({
	...fingerprintAt(`/model/${name}/pi`, runtime),
	id: `endo.evidence.model-fingerprint.${name}`,
});
const fingerprintId = (name: Name) => aliasOf(`endo.evidence.model-fingerprint.${name}`);

interface Skeleton {
	label: string;
	/** The fingerprints in append order. */
	list: Name[];
	/** The one the state names. */
	named: Name;
	/** Which entries of the state are unverified (by position). */
	unverified?: (at: number) => boolean;
	/** Whether the evidence's own runtime varies across worlds (default: yes). */
	evidenceVaries?: boolean;
	/** The families the fingerprints range over (default: all); the state always ranges over all of them, so it can match neither. */
	fingerprintFamilies?: readonly Family[];
	/**
	 * The cells (`mutation | note cites ...`) that are not producible and yet accepted: the wire decides the relation, but this
	 * validator does not enforce it. In each the state's fingerprint is neither embedded in the identity nor cited by its note,
	 * so no kept reference shows that it exists or where it sits. (The note's reference order, which lists the families by their
	 * first appearance, would decide some of them; that refinement is deliberately not taken.)
	 */
	undecided?: string[];
}

interface World {
	runtimes: Record<Name, Family>;
	state: Family;
	/** Whether the cited evidence was recorded for the state's runtime. (Its family is not on the wire: only this is.) */
	evidenceMatchesState: boolean;
}

function worldsOf(skeleton: Skeleton): World[] {
	const worlds: World[] = [];
	const families = skeleton.fingerprintFamilies ?? FAMILIES;
	const assign = (at: number, runtimes: Partial<Record<Name, Family>>): void => {
		if (at === skeleton.list.length) {
			for (const state of FAMILIES)
				for (const evidenceMatchesState of skeleton.evidenceVaries === false ? [true] : [true, false])
					worlds.push({ runtimes: { ...runtimes } as Record<Name, Family>, state, evidenceMatchesState });
			return;
		}
		for (const family of families) assign(at + 1, { ...runtimes, [skeleton.list[at]!]: family });
	};
	assign(0, {});
	return worlds;
}

/** The state's entries: two of the specimen's, enough that an admitted and an unverified one can mix (the relation is uniform across them). */
const STATE_ENTRIES = first.capabilities.slice(0, 2);

function recordsOf(skeleton: Skeleton, world: World) {
	const list = skeleton.list.map((name) => fp(name, world.runtimes[name]));
	const named = list[skeleton.list.indexOf(skeleton.named)]!;
	const cited = new Set(STATE_ENTRIES.map((entry) => entry.evidenceId));
	return {
		...base,
		fingerprint: list,
		evidence: evidenceMatching(base, named)
			.filter((item) => cited.has(item.id))
			.map((item) => ({ ...item, runtime: world.evidenceMatchesState ? world.state : "evidence-only" })),
		state: [
			{
				...first,
				runtime: world.state,
				fingerprintId: named.id,
				capabilities: STATE_ENTRIES.map((entry, at) =>
					skeleton.unverified?.(at) === true
						? { ...entry, status: "unverified", classification: null, evidenceId: null }
						: entry,
				),
			},
		],
	};
}

/**
 * What the wire shows of a snapshot. The registry's content digest binds the records, including the hidden runtimes, and the
 * validator cannot invert it; two worlds that differ only there show the same facts, so it is masked.
 */
const wireOf = (snapshot: any) =>
	canonicalEndoJsonV0(
		mutated(snapshot, (x) => {
			for (const runtime of x.runtimes) {
				runtime.identity.source.watermark.contentDigest = "masked";
				runtime.capabilities.source.watermark.contentDigest = "masked";
			}
		}),
	);

/** The refs a runtime-differs limit may cite, built from the skeleton alone. */
function refsFor(skeleton: Skeleton, attachment: string, view: any) {
	const refOf = (name: Name) => ({
		domain: "harness-registry",
		attachment,
		kind: "fingerprint",
		index: skeleton.list.indexOf(name),
		id: fingerprintId(name),
	});
	return {
		state: structuredClone(view.ref),
		evidence: view.evidence === null ? null : structuredClone(view.evidence.ref),
		named: refOf(skeleton.named),
		latest: refOf(skeleton.list.at(-1)!),
	};
}

/** Mutations applied uniformly to every admitted capability, so the uniformity rule is not what refuses them. */
const MUTATIONS: Record<string, (r: ReturnType<typeof refsFor>) => unknown[] | null> = {
	"no limit": () => null,
	"named only": (r) => [r.state, r.named],
	"latest only": (r) => [r.state, r.latest],
	"named and latest": (r) => [r.state, r.named, r.latest],
	"evidence only": (r) => [r.state, r.evidence],
	"evidence and named": (r) => [r.state, r.evidence, r.named],
	"evidence and latest": (r) => [r.state, r.evidence, r.latest],
	"evidence, named and latest": (r) => [r.state, r.evidence, r.named, r.latest],
};

function applyMutation(skeleton: Skeleton, snapshot: any, name: string): any {
	return mutated(snapshot, (x) => {
		const capabilities = x.runtimes[0].capabilities;
		for (const view of capabilities.capabilities) {
			if (view.status === "unverified") continue;
			const refs = MUTATIONS[name]!(refsFor(skeleton, capabilities.source.attachment, view));
			view.limits = view.limits.filter((limit: { code: string }) => limit.code !== "runtime-differs");
			if (refs !== null) view.limits.push({ code: "runtime-differs", refs });
			view.limits.sort((m: { code: string }, n: { code: string }) => rank(m.code) - rank(n.code));
		}
	});
}

/** Which of the state's fingerprint and the latest the identity's note cites (by id). */
function noteCites(snapshot: any, skeleton: Skeleton): string {
	const note = snapshot.runtimes[0].identity.notes.find((n: { code: string }) => n.code === "runtime-disagreement");
	if (note === undefined) return "none";
	const ids = note.refs.filter((r: { kind: string }) => r.kind === "fingerprint").map((r: { id: string }) => r.id);
	return (
		[
			ids.includes(fingerprintId(skeleton.named)) ? "named" : null,
			ids.includes(fingerprintId(skeleton.list.at(-1)!)) ? "latest" : null,
		]
			.filter(Boolean)
			.join("+") || "other"
	);
}

/** Whether the snapshot shows the state's fingerprint at all: embedded in the identity, or cited by its note. */
function namedShown(snapshot: any, skeleton: Skeleton): boolean {
	const identity = snapshot.runtimes[0].identity;
	const id = fingerprintId(skeleton.named);
	const note = identity.notes.find((n: { code: string }) => n.code === "runtime-disagreement");
	return (
		identity.current?.id === id ||
		identity.previousDifferent?.id === id ||
		(note?.refs ?? []).some((ref: { id: string | null }) => ref.id === id)
	);
}

const SKELETONS: Skeleton[] = [
	{ label: "state names the older of two fingerprints", list: ["a", "b"], named: "a" },
	{ label: "state names the middle of three", list: ["a", "b", "c"], named: "b" },
	{
		label: "state names the oldest of three",
		list: ["a", "b", "c"],
		named: "a",
		undecided: [
			"evidence and latest | note cites latest",
			"evidence and latest | note cites none",
			"evidence and named | note cites latest",
			"evidence only | note cites latest",
			"latest only | note cites latest",
			"latest only | note cites none",
			"named only | note cites latest",
			"no limit | note cites latest",
		],
	},
	{ label: "state names the latest", list: ["a", "b"], named: "b" },
	{ label: "mixed admitted and unverified entries", list: ["a", "b"], named: "a", unverified: (at) => at === 1 },
	{
		label: "four fingerprints, state names the second",
		list: ["a", "b", "c", "d"],
		named: "b",
		evidenceVaries: false,
		fingerprintFamilies: ["pi", "acp"],
		undecided: ["latest only | note cites latest", "latest only | note cites none"],
	},
	{
		label: "four fingerprints, state names the third",
		list: ["a", "b", "c", "d"],
		named: "c",
		evidenceVaries: false,
		fingerprintFamilies: ["pi", "acp"],
	},
];

describe("runtime families: every producible snapshot is accepted, and what no world generates is refused where the wire shows the record", () => {
	for (const skeleton of SKELETONS) {
		it(`${skeleton.label}`, () => {
			const produced = new Map<string, World>();
			const snapshots: { world: World; snapshot: any }[] = [];
			for (const world of worldsOf(skeleton)) {
				const records = recordsOf(skeleton, world);
				const snapshot = snapshotFrom(identityOf(records), capabilitiesOf(records));
				// Worlds the wire cannot tell apart are one snapshot.
				if (produced.has(wireOf(snapshot))) continue;
				snapshots.push({ world, snapshot });
				produced.set(wireOf(snapshot), world);
			}
			// Soundness, part 1: every canonical output of the projectors is accepted.
			for (const { world, snapshot } of snapshots)
				expect(validateEndoCockpitSnapshotV0(snapshot), JSON.stringify(world)).not.toBeNull();

			const refusedProducible: string[] = [];
			const undecided = new Set<string>();
			const undecidedWhileShown: string[] = [];
			for (const { world, snapshot } of snapshots) {
				for (const name of Object.keys(MUTATIONS)) {
					// A skeleton whose evidence never differs in family produces no limit that cites the evidence.
					if (skeleton.evidenceVaries === false && name.includes("evidence")) continue;
					const candidate = applyMutation(skeleton, snapshot, name);
					const accepted = validateEndoCockpitSnapshotV0(candidate) !== null;
					const makes = produced.has(wireOf(candidate));
					const cell = `${name} | note cites ${noteCites(snapshot, skeleton)}`;
					// Soundness, part 2: a snapshot some world generates is accepted.
					if (makes && !accepted) refusedProducible.push(`${cell} ${JSON.stringify(world)}`);
					if (!makes && accepted) {
						undecided.add(cell);
						if (namedShown(snapshot, skeleton)) undecidedWhileShown.push(cell);
					}
				}
			}
			expect(refusedProducible).toEqual([]);
			// Completeness where the wire shows the state's fingerprint: nothing no world generates is accepted.
			expect(undecidedWhileShown).toEqual([]);
			// And elsewhere exactly the declared cells are accepted, no more and no fewer (a stronger validator updates this list).
			expect([...undecided].sort()).toEqual([...(skeleton.undecided ?? [])].sort());
		});
	}
});
