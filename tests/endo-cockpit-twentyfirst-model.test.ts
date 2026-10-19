// PR #57 review round 21: the sparse id ledger (protocol/cockpit-ledger.ts) against the enumerating scan it replaced.
//
// The specification is the PREVIOUS implementation, copied here as written: it walks every declared position, which is only
// feasible, and only done, for genuinely small counts. The sparse scan must agree with it on every input where the
// specification can run - exhaustively for the small state spaces, by deterministic seeded generation for larger ones, with
// defensive entries (a position both shown and discarded, shown at or beyond the count, a later kind holding the repeated
// id, a kind the view does not clean) - and must then give the same answer at any larger count, which the specification
// cannot be asked. Work is measured by counting probes of the supplied collections and reads of the ledger's own arrays, not
// by a clock: both are independent of the declared counts and bounded by the supplied sizes.

import { describe, expect, it } from "vitest";
import { ENDO_COCKPIT_REGISTRY_KINDS_V0 } from "../protocol/cockpit.ts";
import { endoCockpitLedgerV0, scanEndoCockpitDuplicateV0 } from "../protocol/cockpit-ledger.ts";

type Kind = (typeof ENDO_COCKPIT_REGISTRY_KINDS_V0)[number];
type IdKind = Exclude<Kind, "state">;
const KINDS: readonly IdKind[] = ENDO_COCKPIT_REGISTRY_KINDS_V0.filter((kind): kind is IdKind => kind !== "state");
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

interface Ref {
	kind: string;
	index: number;
	id: string;
}

/** The previous implementation of the scan, verbatim in behaviour: it enumerates every position below the bound. */
function specification(
	ref: Ref,
	discarded: ReadonlyMap<string, ReadonlySet<number>>,
	counts: Readonly<Record<string, number>>,
	exposed: ReadonlyMap<string, string>,
): { valid: boolean; kinds: string[] } {
	const kinds = new Set<string>();
	const earlier = new Set<string>();
	for (const kind of ENDO_COCKPIT_REGISTRY_KINDS_V0) {
		if (kind === "state") continue;
		const upto = kind === ref.kind ? ref.index : counts[kind]!;
		for (let at = 0; at < upto; at += 1) {
			earlier.add(`${kind}:${at}`);
			if (discarded.get(kind)?.has(at) === true) continue;
			const id = exposed.get(`${kind}:${at}`);
			if (id === undefined || id === ref.id) kinds.add(kind);
		}
		if (kind === ref.kind) break;
	}
	if (kinds.size === 0) return { valid: false, kinds: [] };
	for (const [position, id] of exposed)
		if (id === ref.id && !earlier.has(position)) return { valid: false, kinds: [...kinds].sort() };
	return { valid: true, kinds: [...kinds].sort() };
}

function sparse(
	ref: Ref,
	discarded: ReadonlyMap<string, ReadonlySet<number>>,
	counts: Readonly<Record<string, number>>,
	exposed: ReadonlyMap<string, string>,
) {
	const result = scanEndoCockpitDuplicateV0(
		endoCockpitLedgerV0(KINDS, counts as Record<IdKind, number>, discarded, exposed),
		ref,
	);
	return { valid: result.valid, kinds: [...result.kinds].sort() };
}

const X = "endo.evidence.x.0";
const Y = "endo.evidence.y.0";

/** Deterministic generator (xorshift32): every failing case reproduces from its seed. */
function generator(seed: number) {
	let state = seed >>> 0 || 1;
	const next = () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state;
	};
	return { below: (n: number) => next() % n, chance: (n: number) => next() % n === 0 };
}

describe("sparse ledger against the enumerating specification", () => {
	it("agrees exhaustively with the specification for counts of 0 and 1 per kind (every discard, every exposure of position 0, every cleaned set)", () => {
		const CLEANED: readonly (readonly Kind[])[] = [
			["fingerprint", "change", "notification"],
			["fingerprint", "evidence", "state"],
			ENDO_COCKPIT_REGISTRY_KINDS_V0,
		];
		let compared = 0;
		const disagreements: string[] = [];
		for (let mask = 0; mask < 16; mask += 1) {
			const counts: Record<string, number> = { state: 1 };
			KINDS.forEach((kind, at) => {
				counts[kind] = (mask >> at) & 1;
			});
			const existing = KINDS.filter((kind) => counts[kind] === 1);
			// Every subset of the positions that exist is discarded in turn.
			for (const cleaned of CLEANED)
				for (let discards = 0; discards < 1 << existing.length; discards += 1) {
					const discarded = new Map<string, Set<number>>();
					for (const kind of cleaned) discarded.set(kind, new Set());
					existing.forEach((kind, at) => {
						if (((discards >> at) & 1) === 1) discarded.get(kind)?.add(0);
					});
					// Every position of position 0 of every kind is shown with nothing, the repeated id or another id: positions
					// that do not exist are shown too (beyond the count), which a canonical projection never does.
					for (let shown = 0; shown < 3 ** 4; shown += 1) {
						const exposed = new Map<string, string>();
						KINDS.forEach((kind, at) => {
							const value = Math.floor(shown / 3 ** at) % 3;
							if (value > 0) exposed.set(`${kind}:0`, value === 1 ? X : Y);
						});
						for (const kind of KINDS)
							for (const index of [0, 1]) {
								const ref = { kind, index, id: X };
								const got = sparse(ref, discarded, counts, exposed);
								const want = specification(ref, discarded, counts, exposed);
								if (JSON.stringify(got) !== JSON.stringify(want))
									disagreements.push(JSON.stringify({ counts, ref, shown, discards, got, want }));
								compared += 1;
							}
					}
				}
		}
		expect(disagreements.slice(0, 3)).toEqual([]);
		expect(compared).toBeGreaterThan(100000);
	});

	it("agrees with the specification on seeded random registries of up to 6 positions per kind, defensive entries included", () => {
		const random = generator(0x5eed);
		let compared = 0;
		const outcomes = { valid: 0, noCandidate: 0, contradiction: 0 };
		for (let round = 0; round < 60000; round += 1) {
			const counts: Record<string, number> = { state: random.below(3) };
			for (const kind of KINDS) counts[kind] = random.below(7);
			const cleaned = KINDS.filter(() => !random.chance(4));
			const discarded = new Map<string, Set<number>>();
			for (const kind of cleaned) discarded.set(kind, new Set());
			const exposed = new Map<string, string>();
			for (const kind of KINDS)
				for (let at = 0; at <= counts[kind]! + 1; at += 1) {
					if (cleaned.includes(kind) && random.chance(3)) discarded.get(kind)!.add(at);
					// A position both shown and discarded, or shown beyond the count, is defensive input, not a canonical one.
					if (random.chance(3))
						exposed.set(`${kind}:${at}`, random.chance(2) ? X : random.chance(2) ? Y : "endo.evidence.z.0");
				}
			if (random.chance(9)) exposed.set(`state:${random.below(3)}`, X);
			const kind = random.chance(40) ? "state" : KINDS[random.below(KINDS.length)]!;
			const ref = { kind, index: random.below((counts[kind] ?? 3) + 2), id: X };
			const got = sparse(ref, discarded, counts, exposed);
			const want = specification(ref, discarded, counts, exposed);
			expect(got, JSON.stringify({ round, counts, ref, discarded: [...discarded], exposed: [...exposed] })).toEqual(
				want,
			);
			compared += 1;
			if (want.valid) outcomes.valid += 1;
			else if (want.kinds.length === 0) outcomes.noCandidate += 1;
			else outcomes.contradiction += 1;
		}
		expect(compared).toBe(60000);
		// Non-vacuous: every verdict of the specification occurs.
		expect(outcomes.valid).toBeGreaterThan(1000);
		expect(outcomes.noCandidate).toBeGreaterThan(1000);
		expect(outcomes.contradiction).toBeGreaterThan(100);
	});

	it("gives at any larger count the answer the specification gives at the smallest count that leaves an unshown position", () => {
		const random = generator(0xc0ffee);
		const BIG = [1_000_000, 1_000_000_000, MAX_SAFE];
		let compared = 0;
		for (let round = 0; round < 3000; round += 1) {
			// Supplied evidence lives below SUPPLIED; every count above SUPPLIED + 1 leaves at least one position unaccounted for.
			const SUPPLIED = 5;
			const discarded = new Map<string, Set<number>>();
			const exposed = new Map<string, string>();
			for (const kind of KINDS) {
				if (!random.chance(5)) discarded.set(kind, new Set());
				for (let at = 0; at < SUPPLIED; at += 1) {
					if (discarded.has(kind) && random.chance(3)) discarded.get(kind)!.add(at);
					if (random.chance(3)) exposed.set(`${kind}:${at}`, random.chance(2) ? X : Y);
				}
			}
			const kind = KINDS[random.below(KINDS.length)]!;
			const ref = { kind, index: random.below(SUPPLIED + 1), id: X };
			const small: Record<string, number> = { state: 1 };
			for (const k of KINDS) small[k] = SUPPLIED + 2;
			const want = specification(ref, discarded, small, exposed);
			for (const count of [SUPPLIED + 2, SUPPLIED + 3, ...BIG]) {
				const counts: Record<string, number> = { state: 1 };
				for (const k of KINDS) counts[k] = count;
				expect(sparse(ref, discarded, counts, exposed), JSON.stringify({ round, count, ref })).toEqual(want);
				compared += 1;
			}
		}
		expect(compared).toBe(3000 * 5);
	});

	it("is exact where the arithmetic is tightest: a duplicate at the last declared position, and counts at the safe-integer limit", () => {
		const counts = (n: number) => ({ fingerprint: n, change: n, evidence: n, notification: n, state: 1 });
		const noDiscard = new Map<string, Set<number>>();
		// The last declared position of the change kind, with only fingerprint 0 shown (with another id): unshown positions exist.
		const last = { kind: "change", index: MAX_SAFE - 1, id: X };
		expect(sparse(last, noDiscard, counts(MAX_SAFE), new Map([["fingerprint:0", Y]]))).toEqual({
			valid: true,
			kinds: ["change", "fingerprint"],
		});
		// Every position below the duplicate accounted for: two shown positions with other ids, nothing else - at a small count.
		const exposed = new Map([
			["fingerprint:0", Y],
			["fingerprint:1", Y],
			["change:0", Y],
		]);
		expect(sparse({ kind: "change", index: 1, id: X }, noDiscard, { ...counts(2), state: 1 }, exposed)).toEqual({
			valid: false,
			kinds: [],
		});
		expect(
			specification({ kind: "change", index: 1, id: X }, noDiscard, { ...counts(2), state: 1 }, exposed),
		).toEqual({
			valid: false,
			kinds: [],
		});
		// All but one position discarded or shown elsewhere at the limit: one unshown position remains, found by subtraction.
		const discarded = new Map([["fingerprint", new Set([0, 1, 2])]]);
		const shown = new Map([["fingerprint:3", Y]]);
		expect(sparse({ kind: "fingerprint", index: 5, id: X }, discarded, counts(MAX_SAFE), shown)).toEqual({
			valid: true,
			kinds: ["fingerprint"],
		});
		expect(sparse({ kind: "fingerprint", index: 4, id: X }, discarded, counts(MAX_SAFE), shown)).toEqual({
			valid: false,
			kinds: [],
		});
		// The earlier kinds at the limit still give candidates; the position beyond the safe integers is never formed.
		expect(sparse({ kind: "notification", index: 0, id: X }, noDiscard, counts(MAX_SAFE), new Map()).kinds).toEqual([
			"change",
			"evidence",
			"fingerprint",
		]);
	});
});

describe("the ledger's work depends on the supplied references, never on the declared counts", () => {
	/** A collection whose every probe is counted, standing in for the sets and maps a projection supplies. */
	class CountingSet extends Set<number> {
		static probes = 0;
		override has(value: number) {
			CountingSet.probes += 1;
			return super.has(value);
		}
		override [Symbol.iterator]() {
			CountingSet.probes += this.size;
			return super[Symbol.iterator]();
		}
	}
	class CountingMap<V> extends Map<string, V> {
		static probes = 0;
		override get(key: string) {
			CountingMap.probes += 1;
			return super.get(key);
		}
		override [Symbol.iterator]() {
			CountingMap.probes += this.size;
			return super[Symbol.iterator]();
		}
	}

	function evidence(discardedCount: number, shownCount: number) {
		const discarded = new CountingMap<ReadonlySet<number>>();
		const exposed = new CountingMap<string>();
		for (const kind of KINDS) {
			const set = new CountingSet();
			for (let at = 0; at < discardedCount; at += 1) set.add(2 * at);
			discarded.set(kind, set);
			for (let at = 0; at < shownCount; at += 1) exposed.set(`${kind}:${2 * at + 1}`, at % 3 === 0 ? X : Y);
		}
		return { discarded, exposed };
	}

	it("probes the supplied collections the same number of times at every declared count, in proportion to their size", () => {
		for (const [discardedCount, shownCount] of [
			[0, 0],
			[3, 5],
			[40, 25],
			[200, 300],
		] as const) {
			const probesAt: number[] = [];
			for (const count of [1000, 1_000_000, 1_000_000_000, MAX_SAFE]) {
				const { discarded, exposed } = evidence(discardedCount, shownCount);
				CountingSet.probes = 0;
				CountingMap.probes = 0;
				const counts: Record<string, number> = { state: 1 };
				for (const kind of KINDS) counts[kind] = count;
				const ledger = endoCockpitLedgerV0(KINDS, counts as Record<IdKind, number>, discarded, exposed);
				for (const kind of KINDS) scanEndoCockpitDuplicateV0(ledger, { kind, index: 999, id: X });
				probesAt.push(CountingSet.probes + CountingMap.probes);
				// Building the ledger touched each supplied entry a bounded number of times, and the scans touched none.
				const supplied = KINDS.length * (discardedCount + shownCount);
				expect(CountingSet.probes + CountingMap.probes).toBeLessThanOrEqual(6 * supplied + 4 * KINDS.length + 8);
			}
			expect(new Set(probesAt).size, `${discardedCount}/${shownCount}: ${probesAt}`).toBe(1);
		}
	});

	it("holds no collection sized by a count: the ledger's arrays are exactly as long as the supplied positions", () => {
		const { discarded, exposed } = evidence(7, 11);
		const counts: Record<string, number> = { state: 1 };
		for (const kind of KINDS) counts[kind] = MAX_SAFE;
		const ledger = endoCockpitLedgerV0(KINDS, counts as Record<IdKind, number>, discarded, exposed);
		for (const kind of KINDS) {
			expect(ledger.discarded.get(kind)).toHaveLength(7);
			expect(ledger.shown.get(kind)).toHaveLength(11);
		}
		// One entry per id and kind: the three-valued evidence uses two ids, so the holder table is two ids wide, not count wide.
		expect(ledger.holders.size).toBe(2);
	});

	it("reads a logarithmic number of entries per scan, however large the count", () => {
		const { discarded, exposed } = evidence(1000, 1000);
		let reads = 0;
		const counted = <T>(list: readonly T[]) =>
			new Proxy(list as T[], {
				get(target, key, receiver) {
					if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
					return Reflect.get(target, key, receiver);
				},
			});
		const counts: Record<string, number> = { state: 1 };
		for (const kind of KINDS) counts[kind] = MAX_SAFE;
		const built = endoCockpitLedgerV0(KINDS, counts as Record<IdKind, number>, discarded, exposed);
		const ledger = {
			...built,
			discarded: new Map(KINDS.map((kind) => [kind, counted(built.discarded.get(kind)!)])),
			shown: new Map(KINDS.map((kind) => [kind, counted(built.shown.get(kind)!)])),
		};
		scanEndoCockpitDuplicateV0(ledger, { kind: "notification", index: 500, id: X });
		// 4 kinds x 2 searches x at most log2(1001) + 1 reads each.
		expect(reads).toBeGreaterThan(0);
		expect(reads).toBeLessThanOrEqual(4 * 2 * 11);
	});
});
