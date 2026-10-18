// PR #57 review round 24: the references of a `runtime-disagreement` note follow the projector's insertion order.
//
// The projector's families are one Map: every kept fingerprint first (a repeated family keeps its FIRST position and cites its
// LATEST fingerprint), then each kept change whose family is new, in index order, never overwritten. So the note is the
// fingerprints' references, then the changes' in strictly rising index. The order WITHIN the fingerprints is the first
// occurrence of each family; only the ordinal bound of round 25 is enforced, and its indices need not rise (A0 B1 A2 cites [2, 1]).

import { describe, expect, it } from "vitest";
import { validateEndoCockpitRuntimeIdentityV0, validateEndoCockpitSnapshotV0 } from "../protocol/cockpit.ts";
import { changeRecord, specimenRecords } from "./cockpit-fixtures.ts";
import { fingerprintAt, foreign, identityOf, mutated, snapshotOf } from "./cockpit-registry-fixtures.ts";

const base = specimenRecords();
type Ref = { kind: string; index: number };

/** A registry of fingerprints and changes whose runtime families are the given letters, every record distinct. */
function registry(fingerprintFamilies: readonly string[], changeFamilies: readonly string[]) {
	return {
		...base,
		fingerprint: fingerprintFamilies.map((family, at) => fingerprintAt(`/p/${family}/${at}`, family)),
		change: changeFamilies.map((family, at) =>
			changeRecord({ id: `endo.evidence.test-change.${at + 1}`, runtime: family } as never),
		),
		notification: [],
		state: [],
	};
}
const noteOf = (value: { notes: { code: string; refs: unknown[] }[] }) =>
	value.notes.find((note) => note.code === "runtime-disagreement");
const refsOf = (value: { notes: { code: string; refs: unknown[] }[] }): Ref[] =>
	((noteOf(value)?.refs ?? []) as Ref[]).map(({ kind, index }) => ({ kind, index }));
const shape = (refs: Ref[]) => refs.map((ref) => `${ref.kind[0]}${ref.index}`).join(" ");
/** The identity with its disagreement note's references replaced (a serialized value in another order). */
const reordered = <T extends { notes: { code: string; refs: unknown[] }[] }>(
	value: T,
	order: (refs: any[]) => any[],
): T =>
	mutated(value, (copy) => {
		const note = copy.notes.find((item: { code: string }) => item.code === "runtime-disagreement");
		note.refs = order(structuredClone(note.refs));
	});
const accepts = (identity: unknown) => validateEndoCockpitRuntimeIdentityV0(identity) !== null;

describe("a runtime-disagreement lists fingerprints before changes (P2)", () => {
	// Two fingerprint families (pi, other), two change families (third, fourth): the note is [f0 f1 c0 c1].
	const mixed = identityOf(registry(["pi", "other"], ["third", "fourth"]));

	it("projects the fingerprints first and the changes after, and the identity and the snapshot validate", () => {
		expect(shape(refsOf(mixed))).toBe("f0 f1 c0 c1");
		expect(accepts(mixed)).toBe(true);
		expect(validateEndoCockpitSnapshotV0(snapshotOf(registry(["pi", "other"], ["third", "fourth"])))).not.toBeNull();
	});

	const orders: [string, (refs: any[]) => any[]][] = [
		["reversed", (r) => [r[3], r[2], r[1], r[0]]],
		["changes first", (r) => [r[2], r[3], r[0], r[1]]],
		["a fingerprint after a change (interleaved)", (r) => [r[0], r[2], r[1], r[3]]],
		["a fingerprint after every change", (r) => [r[0], r[2], r[3], r[1]]],
		["a change before the first fingerprint", (r) => [r[2], r[0], r[1], r[3]]],
		["changes in falling index", (r) => [r[0], r[1], r[3], r[2]]],
	];
	for (const [label, order] of orders)
		it(`refuses ${label}: the identity and the snapshot`, () => {
			const forged = reordered(mixed, order);
			expect(shape(refsOf(forged)), label).not.toBe(shape(refsOf(mixed)));
			expect(accepts(forged), label).toBe(false);
			const snapshot = snapshotOf(registry(["pi", "other"], ["third", "fourth"]));
			const inSnapshot = mutated(snapshot, (copy) => {
				const note = copy.runtimes[0].identity.notes.find(
					(item: { code: string }) => item.code === "runtime-disagreement",
				);
				note.refs = order(structuredClone(note.refs));
			});
			expect(validateEndoCockpitSnapshotV0(inSnapshot), label).toBeNull();
		});

	it("a duplicated change position is refused too (strictly rising, not merely non-falling)", () => {
		expect(accepts(reordered(mixed, (r) => [r[0], r[1], r[2], r[2]]))).toBe(false);
	});
});

describe("what the projector makes is still accepted", () => {
	it("fingerprint-only notes, including falling indices: A0 B1 A2 cites [f2 f1]", () => {
		const identity = identityOf(registry(["a", "b", "a"], []));
		expect(shape(refsOf(identity))).toBe("f2 f1");
		expect(accepts(identity)).toBe(true);
		// (More than one repeat: A0 B1 C2 B3 A4 cites [f4 f3 f2].)
		expect(shape(refsOf(identityOf(registry(["a", "b", "c", "b", "a"], []))))).toBe("f4 f3 f2");
		expect(accepts(identityOf(registry(["a", "b", "c", "b", "a"], [])))).toBe(true);
	});

	it("a change whose family a fingerprint already represents is not cited", () => {
		const identity = identityOf(registry(["a", "b"], ["a", "d"]));
		expect(shape(refsOf(identity))).toBe("f0 f1 c1");
		expect(accepts(identity)).toBe(true);
	});

	it("change-only notes, when no fingerprint is recorded or every one was set aside", () => {
		const none = identityOf(registry([], ["a", "b", "c"]));
		expect(none.current).toBeNull();
		expect(shape(refsOf(none))).toBe("c0 c1 c2");
		expect(accepts(none)).toBe(true);
		const records = registry([], ["a", "b"]);
		const allForeign = identityOf({ ...records, fingerprint: [foreign(fingerprintAt("/x/pi", "a"))] });
		expect(allForeign.current).toBeNull();
		expect(shape(refsOf(allForeign))).toBe("c0 c1");
		expect(accepts(allForeign)).toBe(true);
	});

	it("changes with a set-aside change between them keep their own indices, still rising", () => {
		const records = registry(["a"], ["b", "c", "d"]);
		const identity = identityOf({
			...records,
			change: [records.change[0]!, foreign(records.change[1]!), records.change[2]!],
		});
		expect(shape(refsOf(identity))).toBe("f0 c0 c2");
		expect(accepts(identity)).toBe(true);
	});

	it("every pattern of equal and distinct families, in every split between fingerprints and changes", () => {
		// The projector compares families for equality only, so the patterns below (restricted-growth strings: families named by
		// first appearance across the fingerprints then the changes) cover every registry of up to 3 fingerprints and 3 changes
		// up to renaming. The expected note is restated from the rule: each family, in order of first appearance, cited by its
		// latest fingerprint when it has one, else by its first change.
		const patterns = (length: number): string[][] => {
			const out: string[][] = [];
			const grow = (prefix: string[], used: number) => {
				if (prefix.length === length) return out.push(prefix);
				for (let name = 0; name <= used; name += 1)
					grow([...prefix, String.fromCharCode(97 + name)], Math.max(used, name + 1));
			};
			grow([], 0);
			return out;
		};
		let registries = 0;
		let withBoth = 0;
		for (let fingerprints = 0; fingerprints <= 3; fingerprints += 1) {
			for (let changes = 0; changes <= 3; changes += 1) {
				for (const families of patterns(fingerprints + changes)) {
					const fp = families.slice(0, fingerprints);
					const ch = families.slice(fingerprints);
					const identity = identityOf(registry(fp, ch)); // (the projector checks its own output and throws on a refusal)
					const order = [...new Set(families)];
					const expected: Ref[] = order.map((family) =>
						fp.includes(family)
							? { kind: "fingerprint", index: fp.lastIndexOf(family) }
							: { kind: "change", index: ch.indexOf(family) },
					);
					expect(refsOf(identity), `${fp.join("")}|${ch.join("")}`).toEqual(order.length > 1 ? expected : []);
					expect(accepts(identity), `${fp.join("")}|${ch.join("")}`).toBe(true);
					registries += 1;
					if (order.length > 1) {
						// Every ADJACENT swap of a fingerprint with a change after it, or of two changes, is a refusal.
						const refs = refsOf(identity);
						for (let at = 0; at + 1 < refs.length; at += 1) {
							const a = refs[at]!;
							const b = refs[at + 1]!;
							if (a.kind === "fingerprint" && b.kind === "fingerprint") continue; // (the sweep does not assert their order: see round 25)
							const swapped = reordered(identity, (list) => {
								[list[at], list[at + 1]] = [list[at + 1], list[at]];
								return list;
							});
							expect(accepts(swapped), `${fp.join("")}|${ch.join("")} swap ${at}`).toBe(false);
							withBoth += 1;
						}
					}
				}
			}
		}
		expect(registries).toBe(381);
		expect(withBoth).toBeGreaterThan(100);
	});
});
