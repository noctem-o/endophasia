// PR #57 review round 28: four findings.
//
//  1. (tuUjm) A `notification-change-missing` note is required when the references a view shows are EVERY kept change and none of
//     them carries the notice's id: the projector emits the note exactly when no kept change carries it.
//  2. (tuUjo) A `state-fingerprint-not-recorded` limit is required when the references of both views are every kept fingerprint
//     and none carries the state's id: a `runtime-disagreement` note cites kept fingerprints by complete reference, so they count,
//     as existence and position only, never as a fingerprint's attributes.
//  3. (tu94a) An IPv6 literal of hex letters only is withheld when it has at least three groups (every complete eight-group
//     literal does); a two-group form such as `dead::beef` is code notation as often as an address and is presented.
//  4. (tu94e) NOT implemented. The lower bound on `previousDifferent` rests on "the identity digest includes the runtime family",
//     which no validator or store enforces (the one producer writes the basis with runtime "pi" whatever the record says): two
//     kept fingerprints of different `runtime` strings and equal facts have equal digests, and the proposed rule would refuse the
//     projector's own output for a source the durable store accepts. Pinned below with a real store.
//
// Everything is necessary, not sufficient: a wire that shows only some kept records proves nothing about the others.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import {
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	endoCockpitPresentableTextV0,
	endoCockpitTextPresentableV0,
	endoCockpitTextUnsafeV0,
} from "../protocol/cockpit-fields.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import {
	ATTACHMENT,
	changeRecord,
	event,
	ingestAll,
	notificationRecord,
	removeTempRoots,
	specimenRecords,
	tempRoot,
} from "./cockpit-fixtures.ts";
import { readEndoCockpitSnapshotV0 } from "./cockpit-keyed.ts";
import {
	aliasOf,
	capabilitiesOf,
	fingerprintAt,
	foreign,
	identityOf,
	mutated,
	snapshotFrom,
	timelineOf,
} from "./cockpit-registry-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const WITHHELD = ENDO_COCKPIT_WITHHELD_TEXT_V0;
const base = specimenRecords();
const SPECIMEN_FINGERPRINT = base.fingerprint[0]!.id; // the id the specimen's state names: no fingerprint built below holds it

interface Spec {
	/** Fingerprints by runtime family in order; `-` is set aside as foreign. */
	fingerprints?: string;
	/** Changes by runtime family in order; `-` is set aside as foreign. */
	changes?: string;
	/** What the latest notice names: nothing, a change id no change carries, or the 1-based change at that position. */
	notify?: "missing" | number;
	/** What the state names: an id no fingerprint carries, or the fingerprint at that position of `fingerprints`. */
	named?: number;
}

/** A registry of the specimen's other records with the fingerprints, changes, notice and state described. */
function build(spec: Spec) {
	const fingerprint = [...(spec.fingerprints ?? "")].map((letter, at) =>
		letter === "-" ? foreign(fingerprintAt(`/p/away/${at}`, "away")) : fingerprintAt(`/p/${letter}/${at}`, letter),
	);
	const kept = fingerprint.filter((item) => item.attachment === base.fingerprint[0]!.attachment);
	const currentId = kept.at(-1)?.id ?? SPECIMEN_FINGERPRINT;
	const change = [...(spec.changes ?? "")].map((letter, at) => {
		const record = changeRecord({
			id: `endo.evidence.test-change.${at + 1}`,
			runtime: letter === "-" ? "away" : letter,
			current: { ...changeRecord().current!, fingerprintId: currentId },
		});
		return letter === "-" ? foreign(record) : record;
	});
	const notice =
		spec.notify === undefined
			? []
			: [
					notificationRecord({
						changeId: `endo.evidence.test-change.${spec.notify === "missing" ? 99 : spec.notify}`,
					}),
				];
	const namedId = spec.named === undefined ? SPECIMEN_FINGERPRINT : fingerprint[spec.named]!.id;
	return {
		...base,
		fingerprint,
		change,
		notification: notice,
		state: base.state.map((state) =>
			mutated(state, (copy) => {
				copy.fingerprintId = namedId;
			}),
		),
	};
}

const validIdentity = (value: unknown) => validateEndoCockpitRuntimeIdentityV0(value) !== null;
const validSnapshot = (value: unknown) => validateEndoCockpitSnapshotV0(value) !== null;
const snapshotOfRecords = (records: ReturnType<typeof build>) =>
	snapshotFrom(identityOf(records), capabilitiesOf(records));
const noteOf = (value: { notes: { code: string; refs: unknown[] }[] }, code: string) =>
	value.notes.find((note) => note.code === code);
const shape = (note: { refs: unknown[] } | undefined) =>
	(note?.refs ?? []).map((ref) => `${(ref as { kind: string }).kind[0]}${(ref as { index: number }).index}`).join(" ");
const withoutNote = <T extends { notes: unknown[] }>(value: T, code: string): T =>
	mutated(value, (copy) => {
		copy.notes = copy.notes.filter((note: { code: string }) => note.code !== code);
	});
const withoutNoteInSnapshot = (snapshot: unknown, code: string) =>
	mutated(snapshot, (copy) => {
		copy.runtimes[0].identity.notes = copy.runtimes[0].identity.notes.filter(
			(note: { code: string }) => note.code !== code,
		);
	});
const withoutLimit = (snapshot: unknown, code: string) =>
	mutated(snapshot, (copy) => {
		for (const view of copy.runtimes[0].capabilities.capabilities)
			view.limits = view.limits.filter((limit: { code: string }) => limit.code !== code);
	});

// ---------------------------------------------------------------------------------------------------------------
// 1. A notice naming no change, when every kept change is shown (tuUjm)
// ---------------------------------------------------------------------------------------------------------------

describe("a notice's change that no shown kept change carries needs the missing-change note (P2 tuUjm)", () => {
	it("the finding's case: two kept changes shown (the last, and one cited by the disagreement note), a notice naming a third", () => {
		const records = build({ fingerprints: "a", changes: "ba", notify: "missing" });
		const identity = identityOf(records);
		expect(shape(noteOf(identity, "runtime-disagreement"))).toBe("f0 c0");
		expect((identity.lastChange!.ref as { index: number }).index).toBe(1);
		expect(noteOf(identity, "notification-change-missing")).toBeDefined();
		expect(validIdentity(identity)).toBe(true);
		expect(validIdentity(withoutNote(identity, "notification-change-missing"))).toBe(false);
		const snapshot = snapshotOfRecords(records);
		expect(validSnapshot(snapshot)).toBe(true);
		expect(validSnapshot(withoutNoteInSnapshot(snapshot, "notification-change-missing"))).toBe(false);
	});

	it("a notice naming a shown kept change needs no note, and one added is refused", () => {
		for (const named of [1, 2]) {
			const records = build({ fingerprints: "a", changes: "ba", notify: named });
			const identity = identityOf(records);
			expect(noteOf(identity, "notification-change-missing"), `change ${named}`).toBeUndefined();
			expect(validIdentity(identity)).toBe(true);
			expect(validSnapshot(snapshotOfRecords(records))).toBe(true);
			const forged = mutated(identity, (copy) => {
				copy.notes.push({ code: "notification-change-missing", refs: [copy.lastNotification.ref] });
			});
			expect(validIdentity(forged), `change ${named} with a note`).toBe(false);
		}
	});

	it("an incomplete exposure proves nothing: with a kept change shown by no reference, the note may be absent or present", () => {
		// Changes b, a, a: the disagreement note cites c0 only (the second `a` adds no family), the last change is c2, and c1 is
		// shown by nothing. A notice naming c1 needs no note; one naming no change needs it, but the wire cannot tell which.
		const naming = build({ fingerprints: "a", changes: "baa", notify: 2 });
		const identity = identityOf(naming);
		expect(shape(noteOf(identity, "runtime-disagreement"))).toBe("f0 c0");
		expect(noteOf(identity, "notification-change-missing")).toBeUndefined();
		expect(validIdentity(identity)).toBe(true);
		const missing = identityOf(build({ fingerprints: "a", changes: "baa", notify: "missing" }));
		expect(noteOf(missing, "notification-change-missing")).toBeDefined();
		expect(validIdentity(missing)).toBe(true);
		// Pinned residual (undecidable): the same wire without the note is accepted, because c1 might carry the id.
		expect(validIdentity(withoutNote(missing, "notification-change-missing"))).toBe(true);
	});

	it("keeps its meaning with one kept change, none, and many set aside", () => {
		// One kept change: the notice names it or nothing.
		const one = identityOf(build({ fingerprints: "a", changes: "a", notify: "missing" }));
		expect(validIdentity(one)).toBe(true);
		expect(validIdentity(withoutNote(one, "notification-change-missing"))).toBe(false);
		expect(
			noteOf(identityOf(build({ fingerprints: "a", changes: "a", notify: 1 })), "notification-change-missing"),
		).toBeUndefined();
		// None kept (every change set aside): the note is required.
		const none = identityOf(build({ fingerprints: "a", changes: "--", notify: "missing" }));
		expect(none.lastChange).toBeNull();
		expect(validIdentity(none)).toBe(true);
		expect(validIdentity(withoutNote(none, "notification-change-missing"))).toBe(false);
		// Several set aside around one kept: the one kept is the last and the only one.
		for (const changes of ["--a", "a--", "-a-", "-b-", "b-a"]) {
			const identity = identityOf(build({ fingerprints: "a", changes, notify: "missing" }));
			expect(validIdentity(identity), changes).toBe(true);
			expect(validIdentity(withoutNote(identity, "notification-change-missing")), changes).toBe(false);
		}
		// Two kept with one of them shown by nothing (`-ab-`: the note cites the family-b change, which is also the last, and the
		// family-a change is cited by no one): incomplete, so the wire cannot tell.
		const hiddenOne = identityOf(build({ fingerprints: "a", changes: "-ab-", notify: "missing" }));
		expect(validIdentity(hiddenOne)).toBe(true);
		expect(validIdentity(withoutNote(hiddenOne, "notification-change-missing"))).toBe(true);
	});

	it("a position cited twice is one position: it cannot make the exposure look complete", () => {
		// Three kept changes (b, a, a) with c1 unshown. A note that cites c0 twice is refused as it stands, and the count of
		// distinct positions (two of three) never reaches the retained count.
		const identity = identityOf(build({ fingerprints: "a", changes: "baa", notify: "missing" }));
		const doubled = mutated(identity, (copy) => {
			const note = copy.notes.find((item: { code: string }) => item.code === "runtime-disagreement");
			note.refs.push(structuredClone(note.refs.at(-1)));
		});
		expect(validIdentity(doubled)).toBe(false);
		// A reference to the hidden position added to the note only adds an obligation: with it the note is required.
		const widened = mutated(identity, (copy) => {
			const note = copy.notes.find((item: { code: string }) => item.code === "runtime-disagreement");
			note.refs.push({
				...structuredClone(note.refs.at(-1)),
				index: 1,
				id: aliasOf("endo.evidence.test-change.2"), // the real id of the hidden c1
			});
		});
		expect(validIdentity(widened), "the widened note, with the missing note present").toBe(true);
		expect(validIdentity(withoutNote(widened, "notification-change-missing"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. A state naming no fingerprint, when every kept fingerprint is shown (tuUjo)
// ---------------------------------------------------------------------------------------------------------------

describe("a state's fingerprint that no shown kept fingerprint carries needs the not-recorded limit (P2 tuUjo)", () => {
	const unrecorded = "state-fingerprint-not-recorded";

	it("the finding's case: three kept fingerprints of three families, two embedded and all three cited, a state naming a fourth", () => {
		const records = build({ fingerprints: "abc" });
		const identity = identityOf(records);
		expect(shape(noteOf(identity, "runtime-disagreement"))).toBe("f0 f1 f2");
		expect(identity.current && identity.previousDifferent).toBeTruthy();
		const snapshot = snapshotOfRecords(records);
		expect(
			snapshot.runtimes[0].capabilities.capabilities.some((view: { limits: { code: string }[] }) =>
				view.limits.some((limit) => limit.code === unrecorded),
			),
		).toBe(true);
		expect(validSnapshot(snapshot)).toBe(true);
		expect(validSnapshot(withoutLimit(snapshot, unrecorded))).toBe(false);
		// ... and one admitted capability alone losing it is refused too: each carries the limit.
		const one = mutated(snapshot, (copy) => {
			const view = copy.runtimes[0].capabilities.capabilities.find(
				(item: { status: string }) => item.status === "admitted",
			);
			view.limits = view.limits.filter((limit: { code: string }) => limit.code !== unrecorded);
		});
		expect(validSnapshot(one)).toBe(false);
	});

	it("a state naming a fingerprint a note cites but no view embeds is recorded: the limit is forbidden, the snapshot valid", () => {
		// The contradiction a naive widening would create: every kept fingerprint is shown, one of them by a reference only.
		for (const named of [0, 1, 2]) {
			const records = build({ fingerprints: "abc", named });
			const snapshot = snapshotOfRecords(records);
			const present = snapshot.runtimes[0].capabilities.capabilities.some((view: { limits: { code: string }[] }) =>
				view.limits.some((limit) => limit.code === unrecorded),
			);
			expect(present, `named ${named}`).toBe(false);
			expect(validSnapshot(snapshot), `named ${named}`).toBe(true);
			const forged = mutated(snapshot, (copy) => {
				for (const view of copy.runtimes[0].capabilities.capabilities)
					if (view.status !== "unverified")
						view.limits.push({ code: unrecorded, refs: [copy.runtimes[0].capabilities.state.ref] });
			});
			expect(validSnapshot(forged), `named ${named} with the limit`).toBe(false);
		}
	});

	it("with more kept fingerprints than references, a state naming none proves nothing: the limit may be stripped (pinned residual)", () => {
		// a, b, a: the note cites f2 and f1; f0 is shown by nothing, so a state's unknown id might be f0's.
		const records = build({ fingerprints: "aba" });
		const identity = identityOf(records);
		expect(shape(noteOf(identity, "runtime-disagreement"))).toBe("f2 f1");
		const snapshot = snapshotOfRecords(records);
		expect(validSnapshot(snapshot)).toBe(true);
		expect(validSnapshot(withoutLimit(snapshot, unrecorded))).toBe(true);
	});

	it("repeated families cite one representative each, a discarded fingerprint is no kept position, and the proof still holds", () => {
		// Kept a, b, c after a discarded record: the note cites f1, f2, f3, which are every kept fingerprint.
		const discarded = build({ fingerprints: "-abc" });
		expect(shape(noteOf(identityOf(discarded), "runtime-disagreement"))).toBe("f1 f2 f3");
		const snapshot = snapshotOfRecords(discarded);
		expect(validSnapshot(snapshot)).toBe(true);
		expect(validSnapshot(withoutLimit(snapshot, unrecorded))).toBe(false);
		// a, b, a, b: representatives f2 and f3, with f0 and f1 shown by nothing: undecidable.
		const repeated = snapshotOfRecords(build({ fingerprints: "abab" }));
		expect(validSnapshot(withoutLimit(repeated, unrecorded))).toBe(true);
	});

	it("only admitted entries carry the limit: an unverified capability gains none", () => {
		const records = build({ fingerprints: "abc" });
		const withUnverified = {
			...records,
			state: records.state.map((state) =>
				mutated(state, (copy) => {
					Object.assign(copy.capabilities[0], { status: "unverified", classification: null, evidenceId: null });
				}),
			),
		};
		const snapshot = snapshotOfRecords(withUnverified);
		const unverified = snapshot.runtimes[0].capabilities.capabilities.find(
			(view: { status: string }) => view.status === "unverified",
		);
		expect(unverified.limits).toEqual([]);
		expect(validSnapshot(snapshot)).toBe(true);
		expect(validSnapshot(withoutLimit(snapshot, unrecorded))).toBe(false);
	});

	it("both views must read one registry: a capability view of another source is refused whatever it shows", () => {
		const snapshot = snapshotOfRecords(build({ fingerprints: "abc" }));
		const apart = mutated(snapshot, (copy) => {
			copy.runtimes[0].capabilities.source.watermark.counts.fingerprint += 1;
		});
		expect(validSnapshot(apart)).toBe(false);
		expect(validSnapshot(withoutLimit(apart, unrecorded))).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Letter-only IPv6 (tu94a)
// ---------------------------------------------------------------------------------------------------------------

describe("an IPv6 literal of hex letters only is withheld whole when it has three groups or more (P2 tu94a)", () => {
	const LETTERS = "dead:beef:cafe:babe:dead:beef:cafe:face";
	const withheld = (text: string) => {
		expect(endoCockpitTextUnsafeV0(text), JSON.stringify(text)).toBe(true);
		expect(endoCockpitTextPresentableV0(text), JSON.stringify(text)).toBe(false);
		expect(endoCockpitPresentableTextV0(text), JSON.stringify(text)).toBe(WITHHELD);
	};
	const presented = (text: string) => {
		expect(endoCockpitTextUnsafeV0(text), JSON.stringify(text)).toBe(false);
		expect(endoCockpitPresentableTextV0(text), JSON.stringify(text)).toBe(text);
	};

	it("the finding's literal, bare, bracketed with a port, with a zone, in a sentence and in a compatibility form", () => {
		for (const text of [
			LETTERS,
			`host ${LETTERS} refused the connection`,
			`[${LETTERS}]:443`,
			`${LETTERS}%eth0`,
			`(${LETTERS})`,
			"ＤＥＡＤ:ＢＥＥＦ:ＣＡＦＥ:ＢＡＢＥ:ＤＥＡＤ:ＢＥＥＦ:ＣＡＦＥ:ＦＡＣＥ",
			"ABCD:EF01:2345:6789:ABCD:EF01:2345:6789", // upper case, with digits
		])
			withheld(text);
	});

	it("a compressed letter-only form with three groups or more is withheld, with fewer it is code notation", () => {
		for (const text of ["dead:beef::cafe", "dead:beef:cafe::face", "a:b::c", "face::dead:beef"]) withheld(text);
		for (const text of ["dead::beef", "cafe::babe", "::face", "a::b", "abc::def", "face::", "std::vector"])
			presented(text);
	});

	it("a bracketed literal before a port is withheld at any group count: the port is the evidence, a bare bracket is a slice", () => {
		for (const text of ["[dead::beef]:443", "[a::b]:80", "[::]:80", "host [cafe::babe]:8080 refused"]) withheld(text);
		for (const text of [
			"[dead::beef]",
			"x[a::b]",
			"x[a::b]:y",
			"[dead::beef]:",
			"[dead::beef] :443",
			"[a::b::c]:80",
			"[xyz::b]:80",
		])
			presented(text);
	});

	it("the decimal-digit forms are still withheld", () => {
		for (const text of [
			"::1",
			"fe80::1",
			"[::1]:8080",
			"[fe80::1]:9000",
			"2001:db8::8a2e:370:7334",
			"1::",
			"::ffff:10.0.0.5",
		])
			withheld(text);
	});

	it("controls: MAC addresses, clock times, versions, models and malformed runs are presented", () => {
		for (const text of [
			"aa:bb:cc:dd:ee:ff", // six groups
			"12:30:45",
			"dead:beef:cafe", // three groups, no compression: not an address
			"dead:beef:cafe:babe:dead:beef:cafe", // seven groups
			"dead:beef:cafe:babe:dead:beef:cafe:face:dead", // nine groups
			"dead:beef:cafe:babe:dead:beef:cafe:fxce", // not hex
			"dead:beef:cafe:babe:dead:beef:cafe:12345", // a group of five
			"dead::beef::cafe", // two compressions
			":::",
			"llama3.1:8b",
			"1.2.3",
			"Qwen3.8-27B",
			"retry count: 3",
			"a:b:c",
		])
			presented(text);
	});

	it("through the projectors: a capability reason, a notice title and a timeline reason are withheld whole, the source untouched", () => {
		const records = {
			...base,
			state: base.state.map((state) =>
				mutated(state, (copy) => {
					copy.capabilities[0].reason = `failed connecting to ${LETTERS}`;
				}),
			),
			change: [changeRecord()],
			notification: [notificationRecord({ title: `moved behind [${LETTERS}]:443` })],
		};
		const before = structuredClone(records);
		const capabilities = capabilitiesOf(records);
		const identity = identityOf(records);
		const log = timelineOf(
			event("lifecycle.session-started", {
				runtime: "pi",
				instance: "i-1",
				unavailable: [{ field: "endpoint", reason: `no route to ${LETTERS}` }],
			}),
		);
		expect(capabilities.capabilities[0]!.reason).toBe(WITHHELD);
		expect(identity.lastNotification!.title).toBe(WITHHELD);
		expect(log.entries[0]!.fields["unavailable.endpoint"]).toEqual({ basis: "unavailable", reason: WITHHELD });
		const snapshot = snapshotFrom(identity, capabilities);
		for (const value of [capabilities, identity, log, snapshot])
			for (const leak of [LETTERS, "dead:beef", "cafe:babe", "beef:cafe"])
				expect(JSON.stringify(value).includes(leak), leak).toBe(false);
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		expect(validIdentity(identity)).toBe(true);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		expect(validSnapshot(snapshot)).toBe(true);
		expect(records).toEqual(before);
		expect(JSON.stringify(identityOf(records))).toBe(JSON.stringify(identity));
		// The raw address put back is refused by the wire validators.
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(capabilities, (copy) => {
					copy.capabilities[0].reason = `failed connecting to ${LETTERS}`;
				}),
			),
		).toBeNull();
		expect(
			validIdentity(
				mutated(identity, (copy) => {
					copy.lastNotification.title = LETTERS;
				}),
			),
		).toBe(false);
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(log, (copy) => {
					copy.entries[0].fields["unavailable.endpoint"].reason = LETTERS;
				}),
			),
		).toBeNull();
	});

	it("hostile colon-separated text costs time linear in its length", () => {
		const generators: Record<string, (n: number) => string> = {
			"dead groups": (n) => "dead:".repeat(n / 5),
			"compressed groups": (n) => "dead::".repeat(n / 6),
			"seven-group near misses": (n) => "dead:beef:cafe:babe:dead:beef:cafe ".repeat(n / 36),
			"eight groups, each followed by a letter": (n) => "dead:beef:cafe:babe:dead:beef:cafe:fxce ".repeat(n / 40),
			"single letters": (n) => "a:".repeat(n / 2),
			"letters and double colons": (n) => "a::".repeat(n / 3),
			"one long run": (n) => `${"ab:".repeat(n / 3)}z`,
		};
		const best = (text: string) => {
			let least = Number.POSITIVE_INFINITY;
			for (let run = 0; run < 3; run += 1) {
				const started = performance.now();
				endoCockpitTextUnsafeV0(text);
				least = Math.min(least, performance.now() - started);
			}
			return least;
		};
		for (const [name, make] of Object.entries(generators)) {
			const small = best(make(32_768));
			const large = best(make(524_288));
			expect(large, `${name}: ${small.toFixed(1)} ms at 32K, ${large.toFixed(1)} ms at 512K`).toBeLessThan(
				Math.max(64 * small, 100),
			);
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. previousDifferent (tu94e): NOT implemented, pinned with a real store
// ---------------------------------------------------------------------------------------------------------------

describe("previousDifferent is not bounded by a cited fingerprint of another family: the premise is not enforced (P2 tu94e, not implemented)", () => {
	it("a durable store accepts two kept fingerprints of different runtime strings and equal digests; the cockpit reads it and validates", () => {
		const root = tempRoot();
		// The same facts under two runtime strings: `fingerprintAt` writes the digest with the basis' runtime "pi" whatever the
		// record's runtime is, exactly as the one producer does, and the store checks the digest's shape only.
		const a = fingerprintAt("/p/same/0", "a");
		const b = fingerprintAt("/p/same/1".replace("/1", "/0"), "b");
		expect(a.identity.digest).toBe(b.identity.digest);
		expect(a.runtime).not.toBe(b.runtime);
		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		registry.append("fingerprint", a as never);
		registry.append("fingerprint", b as never);
		ingestAll(root, [event("agent.prompt-accepted")]);
		const snapshot = readEndoCockpitSnapshotV0(root, { attachments: [ATTACHMENT] });
		const identity = snapshot.runtimes[0]!.identity;
		// Two families, so the note cites both fingerprints; their identities are equal, so there is no previous different one.
		expect(shape(noteOf(identity, "runtime-disagreement"))).toBe("f0 f1");
		expect(identity.previousDifferent).toBeNull();
		expect(validSnapshot(snapshot)).toBe(true);
		// A rule "a cited fingerprint of another family bounds previousDifferent from below, so it cannot be null" would refuse
		// this canonical output, and the projector (which checks its own result) would throw on a store the registry opened.
	});

	it("where the digests do differ, previousDifferent is the latest fingerprint with another digest, at or after any cited one", () => {
		// The enumeration the lower bound would rest on is consistent when the premise holds: a, b, a with distinct paths.
		const identity = identityOf(build({ fingerprints: "aba" }));
		expect(shape(noteOf(identity, "runtime-disagreement"))).toBe("f2 f1");
		expect((identity.previousDifferent!.ref as { index: number }).index).toBe(1);
		expect(validIdentity(identity)).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Bounded enumerations against an oracle computed from the history alone
// ---------------------------------------------------------------------------------------------------------------

describe("every small history against an oracle of what the references show", () => {
	const histories = (alphabet: string, maxLength: number): string[] => {
		const out: string[] = [""];
		let layer: string[] = [""];
		for (let length = 1; length <= maxLength; length += 1) {
			layer = layer.flatMap((prefix) => [...alphabet].map((letter) => prefix + letter));
			out.push(...layer);
		}
		return out;
	};
	const kept = (history: string) => [...history].flatMap((letter, at) => (letter === "-" ? [] : [{ letter, at }]));

	it("changes: the note is required exactly when every kept change is shown and none carries the notice's id", () => {
		let covered = 0;
		let hidden = 0;
		for (const fingerprints of ["", "a"]) {
			for (const changes of histories("ab-", 3)) {
				const keptChanges = kept(changes);
				// The families the note shows: fingerprints first, then each kept change whose family is new. A change is shown when
				// it is the last kept change or the note cites it.
				const seen = new Set<string>([...fingerprints]);
				const shown = new Set<number>();
				const introduced: number[] = [];
				for (const { letter, at } of keptChanges) {
					if (seen.has(letter)) continue;
					seen.add(letter);
					introduced.push(at);
				}
				if (seen.size > 1) for (const at of introduced) shown.add(at);
				if (keptChanges.length > 0) shown.add(keptChanges.at(-1)!.at);
				const complete = shown.size === keptChanges.length;
				// A notice may name a kept change, no change, or a change that was set aside: its id is on a cleaning note and is no kept
				// change's id, so the note is emitted for it too.
				const setAside = [...changes].flatMap((letter, at) => (letter === "-" ? [at + 1] : []));
				const targets: ("missing" | number)[] = ["missing", ...keptChanges.map(({ at }) => at + 1), ...setAside];
				for (const notify of targets) {
					const records = build({ fingerprints, changes, notify });
					const identity = identityOf(records); // (the projector checks its own output and throws on a refusal)
					const emitted = noteOf(identity, "notification-change-missing") !== undefined;
					// Emitted exactly when no kept change carries the id: a kept change's own, or none (a missing or set-aside one).
					expect(emitted, `${fingerprints}|${changes}|${notify}`).toBe(
						notify === "missing" || !keptChanges.some(({ at }) => at + 1 === notify),
					);
					expect(validIdentity(identity)).toBe(true);
					if (!emitted) continue;
					const named = validIdentity(withoutNote(identity, "notification-change-missing"));
					// Refused exactly when every kept change is shown (none carries an id no change has).
					expect(named, `${fingerprints}|${changes}|missing`).toBe(!complete);
					if (complete) covered += 1;
					else hidden += 1;
				}
			}
		}
		expect(covered).toBeGreaterThan(20);
		expect(hidden).toBeGreaterThan(3);
	});

	it("fingerprints: the limit is required exactly when every kept fingerprint is shown and the state names none", () => {
		let covered = 0;
		let hidden = 0;
		// Families are named in order of first appearance (a before b before c), so each shape is built once.
		const firstAppearances = (history: string) =>
			[...new Set([...history].filter((letter) => letter !== "-"))].join("");
		for (const fingerprints of histories("abc-", 4)) {
			const keptFingerprints = kept(fingerprints);
			if (keptFingerprints.length === 0 || !"abc".startsWith(firstAppearances(fingerprints))) continue;
			// Shown: the current one, the previous different one (every path is distinct, so every digest is), and, when there
			// are two families or more, the latest fingerprint of each family.
			const shown = new Set<number>();
			shown.add(keptFingerprints.at(-1)!.at);
			if (keptFingerprints.length > 1) shown.add(keptFingerprints.at(-2)!.at);
			const latestOf = new Map<string, number>();
			for (const { letter, at } of keptFingerprints) latestOf.set(letter, at);
			if (latestOf.size > 1) for (const at of latestOf.values()) shown.add(at);
			const complete = shown.size === keptFingerprints.length;
			const records = build({ fingerprints });
			const snapshot = snapshotOfRecords(records); // (the projectors check their own output)
			expect(validSnapshot(snapshot), fingerprints).toBe(true);
			const stripped = validSnapshot(withoutLimit(snapshot, "state-fingerprint-not-recorded"));
			expect(stripped, `${fingerprints}: stripping the limit`).toBe(!complete);
			if (complete) covered += 1;
			else hidden += 1;
			// A state naming a kept fingerprint is recorded, whether or not the wire shows that record: the first and the last kept.
			for (const { at } of [keptFingerprints[0]!, keptFingerprints.at(-1)!])
				expect(
					validSnapshot(snapshotOfRecords(build({ fingerprints, named: at }))),
					`${fingerprints} naming ${at}`,
				).toBe(true);
		}
		expect(covered).toBeGreaterThan(8);
		expect(hidden).toBeGreaterThan(3);
	}, 120_000);
});
