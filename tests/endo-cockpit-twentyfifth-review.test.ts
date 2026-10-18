// PR #57 review round 25: the j-th fingerprint reference of a `runtime-disagreement` note has an index of at least j.
//
// Why it is true of every projection: the family inserted j-th is first seen at the j-th kept fingerprint or later, its cited
// representative is its LATEST kept record, and a kept record's index is at least its position among the kept (a set-aside
// record only widens the gap). It is necessary, not sufficient: it cannot tell `[f3, f2]` (one family seen at 0 and 3, another
// at 1 and 2) from an impossible order; with set-aside records round 26 makes it the j-th KEPT index. Descending indices
// are legitimate (a family seen again cites its newest record but keeps its first position), so no ascending rule is placed.

import { describe, expect, it } from "vitest";
import { validateEndoCockpitRuntimeIdentityV0, validateEndoCockpitSnapshotV0 } from "../protocol/cockpit.ts";
import { changeRecord, specimenRecords } from "./cockpit-fixtures.ts";
import { fingerprintAt, foreign, identityOf, mutated, snapshotOf } from "./cockpit-registry-fixtures.ts";

const base = specimenRecords();
type Ref = { kind: string; index: number };
type Notes = { notes: { code: string; refs: unknown[] }[] };

/** Fingerprints of the given families, in order; a family of `null` is set aside (it names another attachment). */
function registry(families: readonly (string | null)[], changeFamilies: readonly string[] = []) {
	return {
		...base,
		fingerprint: families.map((family, at) => {
			const record = fingerprintAt(`/p/${family ?? "away"}/${at}`, family ?? "away");
			return family === null ? foreign(record) : record;
		}),
		change: changeFamilies.map((family, at) =>
			changeRecord({ id: `endo.evidence.test-change.${at + 1}`, runtime: family } as never),
		),
		notification: [],
		state: [],
	};
}
const noteOf = (value: Notes) => value.notes.find((note) => note.code === "runtime-disagreement");
const refsOf = (value: Notes): Ref[] => (noteOf(value)?.refs ?? []) as Ref[];
const shape = (value: Notes) =>
	refsOf(value)
		.map((ref) => `${ref.kind[0]}${ref.index}`)
		.join(" ");
/** The note's references replaced by those of the canonical list at the given positions, in that order. */
const permuted = <T extends Notes>(value: T, order: readonly number[]): T =>
	mutated(value, (copy) => {
		const note = copy.notes.find((item: { code: string }) => item.code === "runtime-disagreement");
		const original = noteOf(value)!.refs;
		note.refs = order.map((at) => structuredClone(original[at]));
	});
const accepts = (identity: unknown) => validateEndoCockpitRuntimeIdentityV0(identity) !== null;

describe("an impossible order of fingerprint references is refused (P2)", () => {
	const families = ["a", "b", "c"];
	const canonical = identityOf(registry(families));

	it("projects [f0 f1 f2] for three families first seen at 0, 1 and 2, and it validates", () => {
		expect(shape(canonical)).toBe("f0 f1 f2");
		expect(accepts(canonical)).toBe(true);
		expect(validateEndoCockpitSnapshotV0(snapshotOf(registry(families)))).not.toBeNull();
	});

	const permutations: number[][] = [
		[2, 0, 1],
		[1, 0, 2],
		[0, 2, 1],
		[2, 1, 0],
		[1, 2, 0],
	];
	for (const order of permutations)
		it(`refuses [${order.map((at) => `f${at}`).join(" ")}]: as an identity and inside a snapshot`, () => {
			// The same references as the canonical note, in another order: the order is the only thing that differs.
			const forged = permuted(canonical, order);
			expect(
				refsOf(forged)
					.map((ref) => ref.index)
					.sort(),
			).toEqual([0, 1, 2]);
			expect(accepts(forged)).toBe(false);
			const inSnapshot = mutated(snapshotOf(registry(families)), (copy) => {
				const note = copy.runtimes[0].identity.notes.find(
					(item: { code: string }) => item.code === "runtime-disagreement",
				);
				note.refs = order.map((at) => structuredClone(note.refs[at]));
			});
			expect(validateEndoCockpitSnapshotV0(inSnapshot)).toBeNull();
		});

	it("a mixed note: [f1 f0 c0] is refused, and the cross-kind boundary still is", () => {
		const mixed = identityOf(registry(["a", "b"], ["c"]));
		expect(shape(mixed)).toBe("f0 f1 c0");
		expect(accepts(mixed)).toBe(true);
		expect(accepts(permuted(mixed, [1, 0, 2]))).toBe(false);
		for (const order of [
			[0, 2, 1],
			[2, 0, 1],
			[2, 1, 0],
		])
			expect(accepts(permuted(mixed, order)), order.join(",")).toBe(false);
	});
});

describe("repeated families, with the falling indices they give, are still accepted", () => {
	// [history (a letter per fingerprint, `-` set aside), the note the projector makes]
	const cases: [string, string][] = [
		["abaa", "f3 f1"],
		["aba", "f2 f1"],
		["abca", "f3 f1 f2"],
		["abcba", "f4 f3 f2"],
		["-aba", "f3 f2"],
		["abab", "f2 f3"],
	];
	for (const [history, expected] of cases)
		it(`${history.split("").join(" ")} cites [${expected}]`, () => {
			const families = history.split("").map((letter) => (letter === "-" ? null : letter));
			const identity = identityOf(registry(families)); // (the projector checks its own output and throws on a refusal)
			expect(shape(identity)).toBe(expected);
			expect(accepts(identity)).toBe(true);
			expect(validateEndoCockpitSnapshotV0(snapshotOf(registry(families)))).not.toBeNull();
		});

	it("with changes: a falling fingerprint pair then a change, and a change-only note", () => {
		const mixed = identityOf(registry(["a", "b", "a"], ["c"]));
		expect(shape(mixed)).toBe("f2 f1 c0");
		expect(accepts(mixed)).toBe(true);
		const changeOnly = identityOf(registry([], ["a", "b", "c"]));
		expect(shape(changeOnly)).toBe("c0 c1 c2");
		expect(accepts(changeOnly)).toBe(true);
	});
});

describe("the bound against every small history", () => {
	// Every history of up to 5 fingerprints, every subset of them set aside, every pattern of equal and distinct families over
	// the kept ones (the projector compares families for equality only, so these cover every history up to renaming): 278.
	const patterns = (length: number): string[][] => {
		const out: string[][] = [];
		const grow = (prefix: string[], used: number) => {
			if (prefix.length === length) return void out.push(prefix);
			for (let name = 0; name <= used; name += 1)
				grow([...prefix, String.fromCharCode(97 + name)], Math.max(used, name + 1));
		};
		grow([], 0);
		return out;
	};

	it("every note the projector makes obeys it, and every adjacent swap that breaks it is refused", () => {
		let histories = 0;
		let withNote = 0;
		let falling = 0;
		let broken = 0;
		for (let count = 0; count <= 5; count += 1) {
			for (let away = 0; away < 1 << count; away += 1) {
				const kept = Array.from({ length: count }, (_, at) => at).filter((at) => ((away >> at) & 1) === 0);
				for (const pattern of patterns(kept.length)) {
					let next = 0;
					const families = Array.from({ length: count }, (_, at) =>
						((away >> at) & 1) === 1 ? null : pattern[next++]!,
					);
					const identity = identityOf(registry(families));
					histories += 1;
					const refs = refsOf(identity);
					if (refs.length === 0) continue;
					withNote += 1;
					for (const [ordinal, ref] of refs.entries())
						expect(ref.index, `${families.join("")} at ${ordinal}`).toBeGreaterThanOrEqual(ordinal);
					if (refs.some((ref, at) => at > 0 && ref.index < refs[at - 1]!.index)) falling += 1;
					for (let at = 0; at + 1 < refs.length; at += 1) {
						const order = refs.map((_, position) => position);
						[order[at], order[at + 1]] = [order[at + 1]!, order[at]!];
						// Only a swap that BREAKS the bound is asserted: some swaps that satisfy it are infeasible, and pinning their
						// acceptance would pin the bound's incompleteness.
						if (!order.some((from, ordinal) => refs[from]!.index < ordinal)) continue;
						expect(accepts(permuted(identity, order)), `${families.join("")} swap ${at}`).toBe(false);
						broken += 1;
					}
				}
			}
		}
		expect(histories).toBe(278);
		expect(withNote).toBeGreaterThan(150);
		expect(falling).toBeGreaterThan(50); // descending indices are common, so an ascending rule would be unsound
		expect(broken).toBeGreaterThan(100);
	});
});
