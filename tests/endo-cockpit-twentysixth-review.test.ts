// PR #57 review round 26: the j-th fingerprint reference of a `runtime-disagreement` note is a KEPT record of rank at least j.
//
// Round 25 bounded the raw index by the ordinal j. With fingerprints set aside (a foreign record, a repeated id) the exact bound
// is the j-th kept index K[j]: the family inserted j-th is first seen at the j-th kept fingerprint or later, and its cited record
// is its latest, so index >= K[j]. The validator computes it as a rank, `index - (discarded fingerprints below index)`, with a
// binary search over the discards the cleaning notes name: nothing is walked between positions, so a declared count of
// Number.MAX_SAFE_INTEGER costs the same as 3. Necessary, not sufficient (see the oracle test at the end).

import { describe, expect, it } from "vitest";
import { validateEndoCockpitRuntimeIdentityV0, validateEndoCockpitSnapshotV0 } from "../protocol/cockpit.ts";
import { endoCockpitBelowV0 } from "../protocol/cockpit-ledger.ts";
import { changeRecord, specimenRecords } from "./cockpit-fixtures.ts";
import { fingerprintAt, foreign, identityOf, mutated, snapshotOf } from "./cockpit-registry-fixtures.ts";

const base = specimenRecords();
type Ref = { kind: string; index: number };
type Notes = { notes: { code: string; refs: unknown[] }[] };

/** Fingerprints by family, in order. `-` is set aside as foreign, `=` as a repeated id (it repeats the record before it). */
function registry(history: string, changeFamilies: readonly string[] = []) {
	const fingerprint: any[] = [];
	for (const [at, letter] of [...history].entries()) {
		if (letter === "-") fingerprint.push(foreign(fingerprintAt(`/p/away/${at}`, "away")));
		else if (letter === "=")
			fingerprint.push({ ...fingerprintAt(`/p/same/${at}`, "same"), id: fingerprint[at - 1].id });
		else fingerprint.push(fingerprintAt(`/p/${letter}/${at}`, letter));
	}
	return {
		...base,
		fingerprint,
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
const permuted = <T extends Notes>(value: T, order: readonly number[]): T =>
	mutated(value, (copy) => {
		const note = copy.notes.find((item: { code: string }) => item.code === "runtime-disagreement");
		const original = noteOf(value)!.refs;
		note.refs = order.map((at) => structuredClone(original[at]));
	});
const accepts = (identity: unknown) => validateEndoCockpitRuntimeIdentityV0(identity) !== null;
const inSnapshot = (history: string, order: readonly number[]) =>
	validateEndoCockpitSnapshotV0(
		mutated(snapshotOf(registry(history)), (copy) => {
			const note = copy.runtimes[0].identity.notes.find(
				(item: { code: string }) => item.code === "runtime-disagreement",
			);
			note.refs = order.map((at) => structuredClone(note.refs[at]));
		}),
	) !== null;

describe("a discarded prefix moves the bound: the kept rank, not the raw ordinal (P2)", () => {
	it("the finding's case: fingerprint 0 set aside, A at 1, B at 2: [f1 f2] validates and [f2 f1] does not", () => {
		const canonical = identityOf(registry("-ab"));
		expect(shape(canonical)).toBe("f1 f2");
		expect(accepts(canonical)).toBe(true);
		expect(validateEndoCockpitSnapshotV0(snapshotOf(registry("-ab")))).not.toBeNull();
		const forged = permuted(canonical, [1, 0]);
		expect(shape(forged)).toBe("f2 f1");
		expect(accepts(forged)).toBe(false);
		expect(inSnapshot("-ab", [1, 0])).toBe(false);
		// Nothing else differs: the same value with the references put back is the canonical projection.
		expect(JSON.stringify(permuted(forged, [1, 0]))).toBe(JSON.stringify(canonical));
	});

	// [history, the canonical note]; every other order of the references is refused except where the oracle below says a registry
	// produces it. Each of these is accepted by the round-25 raw-ordinal bound for at least one other order.
	const refused: [string, string, number[][]][] = [
		["-ab", "f1 f2", [[1, 0]]],
		[
			"--abc",
			"f2 f3 f4",
			[
				[1, 0, 2],
				[0, 2, 1],
				[2, 0, 1],
				[2, 1, 0],
				[1, 2, 0],
			],
		],
		[
			"a-bc",
			"f0 f2 f3",
			[
				[0, 2, 1],
				[1, 0, 2],
				[1, 2, 0],
				[2, 0, 1],
				[2, 1, 0],
			],
		],
		[
			"a=bc",
			"f0 f2 f3",
			[
				[0, 2, 1],
				[1, 0, 2],
				[1, 2, 0],
				[2, 0, 1],
				[2, 1, 0],
			],
		],
		[
			// Two repeated ids set aside at 1 and 2 (both carry record 0's id): kept 0, 3, 4. [f0 f4 f3] passes the raw bound (3 >= 2).
			"a==bc",
			"f0 f3 f4",
			[
				[0, 2, 1],
				[1, 0, 2],
				[1, 2, 0],
				[2, 0, 1],
				[2, 1, 0],
			],
		],
	];
	for (const [history, expected, orders] of refused)
		it(`${history.split("").join(" ")} cites [${expected}]: the other orders that break the kept bound are refused`, () => {
			const spec = history;
			const canonical = identityOf(registry(spec));
			expect(shape(canonical)).toBe(expected);
			expect(accepts(canonical)).toBe(true);
			for (const order of orders) {
				const kept = refsOf(canonical).map((ref) => ref.index);
				// Refuse only the orders whose j-th reference sits below the j-th kept index.
				const keptIndices = [...spec].flatMap((letter, at) => (letter === "-" || letter === "=" ? [] : [at]));
				if (!order.some((from, j) => kept[from]! < keptIndices[j]!)) continue;
				expect(accepts(permuted(canonical, order)), `${spec} ${order}`).toBe(false);
			}
		});

	it("a repeated id set aside gives the same answer as a foreign record: a=bc cites [f0 f2 f3] and [f0 f3 f2] is refused", () => {
		const canonical = identityOf(registry("a=bc"));
		expect(canonical.notes.map((note) => note.code)).toContain("duplicate-record-id");
		expect(shape(canonical)).toBe("f0 f2 f3");
		expect(accepts(permuted(canonical, [0, 2, 1]))).toBe(false); // f2 sits at ordinal 2: rank 1 < 2
		const raw = (history: string) => shape(identityOf(registry(history)));
		expect(raw("a-bc")).toBe(raw("a=bc"));
	});
});

describe("descending representatives are still accepted, with or without a discarded prefix", () => {
	const cases: [string, string][] = [
		["aba", "f2 f1"],
		["abaa", "f3 f1"],
		["abcba", "f4 f3 f2"],
		["-aba", "f3 f2"], // a discarded prefix, then A at 1, B at 2, A again at 3: a falling pair
		["--abca", "f5 f3 f4"],
		["a-ba", "f3 f2"],
		["ab-a", "f3 f1"],
		["-ab-a", "f4 f2"],
		["-abab", "f3 f4"],
	];
	for (const [history, expected] of cases)
		it(`${history.split("").join(" ")} cites [${expected}]`, () => {
			const identity = identityOf(registry(history)); // (the projector checks its own output and throws on a refusal)
			expect(shape(identity)).toBe(expected);
			expect(accepts(identity)).toBe(true);
			expect(validateEndoCockpitSnapshotV0(snapshotOf(registry(history)))).not.toBeNull();
		});

	it("mixed, fingerprint-only, change-only, and no fingerprint kept", () => {
		const mixed = identityOf(registry("-ab", ["c"]));
		expect(shape(mixed)).toBe("f1 f2 c0");
		expect(accepts(mixed)).toBe(true);
		expect(accepts(permuted(mixed, [1, 0, 2]))).toBe(false);
		expect(accepts(permuted(mixed, [0, 2, 1]))).toBe(false);
		const changeOnly = identityOf(registry("--", ["a", "b"]));
		expect(changeOnly.current).toBeNull();
		expect(shape(changeOnly)).toBe("c0 c1");
		expect(accepts(changeOnly)).toBe(true);
		// With nothing set aside nothing moved: round 25's raw bound is the kept bound.
		expect(shape(identityOf(registry("aba")))).toBe("f2 f1");
	});

	it("discards at multi-digit positions: the sort is numeric, not lexicographic", () => {
		// Positions 2 and 10 are set aside. Sorted lexicographically they are [10, 2], and a binary search over that puts position 5
		// above both discards: rank 3, below the 4 its ordinal needs, which would refuse the projector's own note.
		const identity = identityOf(registry("ab-cdeabcd-a"));
		expect(shape(identity)).toBe("f11 f7 f8 f9 f5");
		expect(accepts(identity)).toBe(true);
		expect(endoCockpitBelowV0([2, 10], 5)).toBe(1);
		expect(endoCockpitBelowV0([10, 2], 5)).toBe(2); // the unsorted array: why the validator sorts numerically
	});
});

describe("the bound costs the supplied discards, not the declared count", () => {
	const identity = identityOf(registry("-ab"));
	/** The identity declaring N fingerprints: its latest record moves to the end (every reference to it follows). */
	function declaring(count: number) {
		const text = JSON.stringify(identity)
			.split('"kind":"fingerprint","index":2')
			.join(`"kind":"fingerprint","index":${count - 1}`);
		const out = JSON.parse(text);
		out.source.watermark.counts.fingerprint = count;
		return out;
	}

	it("reads at most about log2(D) entries of the discards, at any bound", () => {
		for (const size of [0, 1, 2, 7, 1000]) {
			const sorted = Array.from({ length: size }, (_, at) => at * 3);
			let reads = 0;
			const counted = new Proxy(sorted, {
				get(target, key, receiver) {
					if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
					return Reflect.get(target, key, receiver);
				},
			});
			for (const bound of [0, 5, 1_000_000, Number.MAX_SAFE_INTEGER]) {
				reads = 0;
				const below = endoCockpitBelowV0(counted, bound);
				expect(below).toBe(sorted.filter((value) => value < bound).length);
				expect(reads, `${size} discards, bound ${bound}`).toBeLessThanOrEqual(Math.ceil(Math.log2(size + 1)) + 1);
			}
		}
	});

	it("the canonical identity and its reordering get the same verdicts at declared counts from 3 to MAX_SAFE_INTEGER", () => {
		for (const count of [3, 10, 1_000_000, 1_000_000_000, Number.MAX_SAFE_INTEGER]) {
			const canonical = declaring(count);
			const started = performance.now();
			expect(accepts(canonical), `canonical ${count}`).toBe(true);
			expect(accepts(permuted(canonical, [1, 0])), `reordered ${count}`).toBe(false);
			// (A second, weaker check beside the read count above: a walk over the declared positions would take far longer.)
			expect(performance.now() - started, `${count}`).toBeLessThan(300);
		}
	});

	it("the discards must be positions the watermark declares, once each: otherwise the note is refused before the bound", () => {
		const beyond = mutated(identity, (copy) => {
			const cleaning = copy.notes.find((note: { code: string }) => note.code === "foreign-attachment-record");
			cleaning.refs[0].index = copy.source.watermark.counts.fingerprint; // one past the last declared position
		});
		expect(accepts(beyond)).toBe(false);
		const twice = mutated(identity, (copy) => {
			const cleaning = copy.notes.find((note: { code: string }) => note.code === "foreign-attachment-record");
			copy.notes.push(structuredClone(cleaning));
		});
		expect(accepts(twice)).toBe(false);
	});
});

describe("every small history against an independent oracle of what a registry can produce", () => {
	// A registry's kept fingerprints, labelled by family, produce the cited ranks `last occurrence of each label, labels in
	// order of first appearance`. This oracle enumerates those directly, without the projector or the validator.
	const labelings = (n: number): number[][] => {
		const out: number[][] = [];
		const grow = (prefix: number[], used: number) => {
			if (prefix.length === n) return void out.push(prefix);
			for (let label = 0; label <= used; label += 1) grow([...prefix, label], Math.max(used, label + 1));
		};
		grow([], 0);
		return out;
	};
	const producibleRanks = (kept: number) =>
		new Set(
			labelings(kept)
				.filter((labels) => Math.max(...labels) >= 1)
				.map((labels) =>
					Array.from({ length: Math.max(...labels) + 1 }, (_, label) => labels.lastIndexOf(label)).join(","),
				),
		);
	const orders = (length: number): number[][] =>
		length <= 1
			? [Array.from({ length }, (_, at) => at)]
			: orders(length - 1).flatMap((rest) =>
					Array.from({ length }, (_, at) => [...rest.slice(0, at), length - 1, ...rest.slice(at)]),
				);
	const patterns = (length: number): string[] => {
		const out: string[] = [];
		const grow = (prefix: string, used: number) => {
			if (prefix.length === length) return void out.push(prefix);
			for (let name = 0; name <= used; name += 1)
				grow(prefix + String.fromCharCode(97 + name), Math.max(used, name + 1));
		};
		grow("", 0);
		return out;
	};

	it("never refuses an order a registry produces, and refuses every order below the j-th kept index", () => {
		let histories = 0;
		let candidates = 0;
		let refusedOnlyByKeptBound = 0;
		for (let count = 0; count <= 5; count += 1) {
			for (let away = 0; away < 1 << count; away += 1) {
				const keptAt = Array.from({ length: count }, (_, at) => at).filter((at) => ((away >> at) & 1) === 0);
				for (const pattern of patterns(keptAt.length)) {
					let next = 0;
					const history = Array.from({ length: count }, (_, at) =>
						((away >> at) & 1) === 1 ? "-" : pattern[next++]!,
					).join("");
					const identity = identityOf(registry(history));
					histories += 1;
					const refs = refsOf(identity);
					if (refs.length < 2) continue;
					const producible = producibleRanks(keptAt.length);
					for (const order of orders(refs.length)) {
						candidates += 1;
						const cited = order.map((from) => refs[from]!.index);
						const ranks = cited.map((index) => keptAt.indexOf(index));
						const belowKept = cited.some((index, j) => index < keptAt[j]!);
						const belowOrdinal = cited.some((index, j) => index < j);
						const verdict = accepts(permuted(identity, order));
						if (producible.has(ranks.join(",")))
							expect(verdict, `${history} [${cited}] is produced by a registry`).toBe(true);
						if (belowKept) expect(verdict, `${history} [${cited}] is below the kept index`).toBe(false);
						if (belowKept && !belowOrdinal) refusedOnlyByKeptBound += 1;
					}
				}
			}
		}
		expect(histories).toBe(278);
		expect(candidates).toBeGreaterThan(1000);
		expect(refusedOnlyByKeptBound).toBeGreaterThan(20); // orders round 25's raw bound accepted
	});
});
