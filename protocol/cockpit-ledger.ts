// The id ledger behind `duplicate-record-id` validation, kept SPARSE: its work depends on the references a projection supplies
// (cleaning notes, presented records, kept references) and on the number of kinds, never on the record counts a watermark
// declares. A serialized projection is untrusted input: it can state a count near Number.MAX_SAFE_INTEGER in a few bytes, so
// nothing here walks, allocates or names a position that is not itself supplied.
//
// The cleaner keeps one id ledger over the kinds that carry an id, in a fixed order (fingerprint, change, evidence,
// notification): a record repeats an id only if an earlier record of an earlier kind, or of its own kind before it, was KEPT,
// and kept records carry distinct ids. So the owner of a repeated id X is one of the CANDIDATES among the earlier positions:
// not known to be discarded, and not shown to carry another id. A position that is neither discarded nor shown has an id that
// is simply not known, and stays a candidate. This module counts those positions by subtraction; it does not list them.
//
// Preconditions (established by the wire validators before any ledger is built): every position is a safe non-negative
// integer (`isRef` requires it of every reference, and a tail is `count - 1`), and a position is named by `kind:index`.
// Nothing here imports the contract: the kinds and their order are passed in, so the scan can be tested on its own.

/** The lowest non-discarded and the highest (discarded or not) shown position of one kind that carries one id. */
interface Holder {
	low: number | null;
	high: number;
}

export interface EndoCockpitLedgerV0<K extends string> {
	/** The kinds that carry an id, in the cleaner's order. */
	readonly kinds: readonly K[];
	/** The record count the watermark declares per kind: read only in arithmetic, never as a loop bound. */
	readonly counts: Readonly<Record<K, number>>;
	/** Per kind, the positions known to be discarded: sorted, distinct. */
	readonly discarded: ReadonlyMap<K, readonly number[]>;
	/** Per kind, the positions shown with an id and not discarded: sorted, distinct, disjoint from `discarded`. */
	readonly shown: ReadonlyMap<K, readonly number[]>;
	/** Per id and kind, where records shown with that id sit. A kind that carries no id is recorded too. */
	readonly holders: ReadonlyMap<string, ReadonlyMap<string, Holder>>;
}

const ascending = (a: number, b: number): number => a - b;

/**
 * How many entries of the sorted list are below `bound`: a binary search. Also how the identity validator ranks a position among
 * the KEPT records of a kind (`index - below(discarded, index)`), without walking the positions between.
 */
export function endoCockpitBelowV0(sorted: readonly number[], bound: number): number {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (sorted[middle]! < bound) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * The ledger facts of one registry projection. `discarded` maps a kind to the positions its cleaning notes discard (a kind the
 * notes do not clean is absent: nothing is known to be discarded in it). `exposed` maps `kind:index` to the id of a record the
 * projection shows. Time O((D + E) log (D + E)) and space O(D + E) for D discarded and E shown positions.
 */
export function endoCockpitLedgerV0<K extends string>(
	kinds: readonly K[],
	counts: Readonly<Record<K, number>>,
	discarded: ReadonlyMap<string, ReadonlySet<number>>,
	exposed: ReadonlyMap<string, string>,
): EndoCockpitLedgerV0<K> {
	const discardedSorted = new Map<K, readonly number[]>(
		kinds.map((kind) => [kind, [...(discarded.get(kind) ?? [])].sort(ascending)] as const),
	);
	const shown = new Map<K, number[]>(kinds.map((kind) => [kind, []] as const));
	const holders = new Map<string, Map<string, Holder>>();
	for (const [position, id] of exposed) {
		const cut = position.indexOf(":");
		const kind = position.slice(0, cut);
		const index = Number(position.slice(cut + 1));
		const set = discarded.get(kind)?.has(index) === true;
		if (!set) (shown.get(kind as K) ?? []).push(index);
		let byKind = holders.get(id);
		if (byKind === undefined) {
			byKind = new Map();
			holders.set(id, byKind);
		}
		const holder = byKind.get(kind);
		if (holder === undefined) byKind.set(kind, { low: set ? null : index, high: index });
		else {
			if (!set && (holder.low === null || index < holder.low)) holder.low = index;
			if (index > holder.high) holder.high = index;
		}
	}
	for (const list of shown.values()) list.sort(ascending);
	return { kinds, counts, discarded: discardedSorted, shown, holders };
}

/**
 * Whether a `duplicate-record-id` note for the record at `ref` can be genuine, and the kinds of the records that could own the
 * id. Visits the kinds in ledger order up to and including the note's own (earlier positions of it only); for each visited
 * kind with `upto` earlier positions, the candidates are the positions not discarded and not shown with another id: those
 * shown with `ref.id`, and every position neither discarded nor shown, counted as `upto - discarded below - shown below`
 * (the two sets are disjoint subsets of `[0, upto)`, so no position is subtracted twice and the result is exact). The note is
 * impossible when no kind has a candidate, and when a record shown with `ref.id` sits where no earlier record does (a later
 * kind, or at or after `upto`): the owner sits before the duplicate. Time O(kinds * log (D + E)); every term is at most
 * Number.MAX_SAFE_INTEGER and the two subtrahends never exceed `upto` together, so the arithmetic is exact.
 */
export function scanEndoCockpitDuplicateV0<K extends string>(
	ledger: EndoCockpitLedgerV0<K>,
	ref: { kind: string; index: number; id: string },
): { valid: boolean; kinds: ReadonlySet<K> } {
	const kinds = new Set<K>();
	const upto = new Map<string, number>();
	const held = ledger.holders.get(ref.id);
	for (const kind of ledger.kinds) {
		const bound = kind === ref.kind ? ref.index : ledger.counts[kind];
		upto.set(kind, bound);
		const unknown =
			bound -
			endoCockpitBelowV0(ledger.discarded.get(kind)!, bound) -
			endoCockpitBelowV0(ledger.shown.get(kind)!, bound);
		const low = held?.get(kind)?.low ?? null;
		if (unknown > 0 || (low !== null && low < bound)) kinds.add(kind);
		if (kind === ref.kind) break;
	}
	if (kinds.size === 0) return { valid: false, kinds };
	if (held !== undefined)
		for (const [kind, holder] of held) {
			const bound = upto.get(kind);
			if (bound === undefined || holder.high >= bound) return { valid: false, kinds };
		}
	return { valid: true, kinds };
}
