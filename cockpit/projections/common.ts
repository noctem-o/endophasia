// Shared pieces of the pure cockpit projections: input shapes, reference and claim builders, and the one comparison used
// wherever the contract promises "code-unit order". Nothing here reads a file, a clock or the environment.

import type {
	EndoCockpitClaimV0,
	EndoCockpitNoteCodeV0,
	EndoCockpitNoteV0,
	EndoCockpitRefV0,
	EndoCockpitRegistryKindV0,
	EndoCockpitRegistrySourceV0,
	EndoCockpitRegistryWatermarkV0,
	EndoCockpitSourceConditionV0,
} from "../../protocol/cockpit.ts";
import { ENDO_COCKPIT_REGISTRY_KINDS_V0 } from "../../protocol/cockpit.ts";
import {
	endoCockpitPresentableTextV0,
	endoCockpitTextUnsafeV0,
	isEndoCockpitSourceIdAdmittedV0,
	isEndoCockpitSourceKindAdmittedV0,
} from "../../protocol/cockpit-fields.ts";
import type {
	EndoCapabilityEvidenceV0,
	EndoCapabilityStateV0,
	EndoHarnessChangeV0,
	EndoHarnessFingerprintV0,
	EndoHarnessNotificationV0,
} from "../../protocol/harness.ts";
import { parseEndoIdentifierV0 } from "../../protocol/identity.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";

/** The validated records of one attachment's registry, each kind in append order. */
export interface EndoCockpitRegistryRecordsV0 {
	fingerprint: readonly EndoHarnessFingerprintV0[];
	change: readonly EndoHarnessChangeV0[];
	evidence: readonly EndoCapabilityEvidenceV0[];
	state: readonly EndoCapabilityStateV0[];
	notification: readonly EndoHarnessNotificationV0[];
}

/**
 * Input of the registry projections: where the records came from, and the records. `records` is null when the registry
 * is absent or could not be opened; the projection then says so instead of presenting an empty registry.
 */
export interface EndoCockpitRegistryInputV0 {
	source: EndoCockpitRegistrySourceV0;
	records: EndoCockpitRegistryRecordsV0 | null;
}

/** One record with its position among the records of its kind. */
export interface EndoCockpitIndexedV0<T> {
	record: T;
	index: number;
}

/** Text that is not presentable whole (a path, an address, a credential, control characters): see the protocol policy. */
export const looksSensitiveTextV0 = endoCockpitTextUnsafeV0;

/**
 * The text itself, or the fixed withheld text when it is not presentable whole: flagged, empty, or longer than the cockpit's
 * 256-character bound. The one rule for every free text a record author wrote (a capability reason, a limitation, a title,
 * a version, a label): judged on the whole value, never cut.
 */
export function presentableTextV0(text: string): string {
	return endoCockpitPresentableTextV0(text);
}

/**
 * The deterministic placeholders of a projection, under an explicit digest key. A placeholder is the first 32 hex digits
 * of an HMAC of the withheld value, domain-separated by what it stands for; without the key it can be neither recomputed
 * from a guess nor confirmed against one. The same value gives the same placeholder under one key, everywhere, so every
 * reference relationship is kept; under another key it gives another.
 */
export interface EndoCockpitAliasesV0 {
	/** An identifier as presented: itself when admitted (isEndoCockpitSourceIdAdmittedV0), else its alias. */
	id(id: string): string;
	/** A dotted kind as presented: itself when admitted, else `withheld-` and its token. */
	kind(kind: string): string;
	/**
	 * A stored digest whose preimage includes data the cockpit withholds (the identity digest covers the real path, the
	 * configuration digest the user's configuration, a supporting digest a transcript), as presented: a keyed token of
	 * it. Equal stored digests give equal tokens under one key, so every comparison between views holds.
	 */
	digest(purpose: "identity" | "configuration" | "supporting", hex: string): string;
}

/** The purposes the cockpit's keyed tokens are domain-separated by (each is part of the digested value). */
export const ENDO_COCKPIT_TOKEN_PURPOSES_V0 = {
	idAlias: "endo.cockpit.id-alias.v0",
	kindAlias: "endo.cockpit.kind-alias.v0",
	eventPrefix: "endo.cockpit.event-prefix.v0",
	registryContent: "endo.cockpit.registry-content.v0",
	tornTail: "endo.cockpit.torn-tail.v0",
	identityDigest: "endo.cockpit.identity-digest.v0",
	configurationDigest: "endo.cockpit.configuration-digest.v0",
	supportingDigest: "endo.cockpit.supporting-digest.v0",
} as const;

/** 64 hex characters of the HMAC of `{ purpose, ...parts }` under the key. */
export function cockpitTokenV0(key: EndoDigestKeyV0, purpose: string, parts: Record<string, unknown>): string {
	return key.digest({ purpose, ...parts }).value;
}

export function cockpitAliasesV0(key: EndoDigestKeyV0): EndoCockpitAliasesV0 {
	return {
		id(id) {
			// Only a source identifier admitted as it is passes through: the generated-alias namespace is reserved, so a
			// source identifier that looks like an alias is itself aliased, and no two distinct identifiers share one.
			if (isEndoCockpitSourceIdAdmittedV0(id)) return id;
			const kind = parseEndoIdentifierV0(id)?.kind ?? "evidence";
			return `endo.${kind}.withheld-${cockpitTokenV0(key, ENDO_COCKPIT_TOKEN_PURPOSES_V0.idAlias, { id }).slice(0, 32)}`;
		},
		digest(purpose, hex) {
			const name = {
				identity: ENDO_COCKPIT_TOKEN_PURPOSES_V0.identityDigest,
				configuration: ENDO_COCKPIT_TOKEN_PURPOSES_V0.configurationDigest,
				supporting: ENDO_COCKPIT_TOKEN_PURPOSES_V0.supportingDigest,
			}[purpose];
			return cockpitTokenV0(key, name, { digest: hex });
		},
		kind(kind) {
			return isEndoCockpitSourceKindAdmittedV0(kind)
				? kind
				: `withheld-${cockpitTokenV0(key, ENDO_COCKPIT_TOKEN_PURPOSES_V0.kindAlias, { kind }).slice(0, 32)}`;
		},
	};
}

/** Order two strings by UTF-16 code unit, independent of the host's locale. */
export function compareCodeUnitsV0(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function registryRefV0(
	alias: EndoCockpitAliasesV0,
	attachment: string,
	kind: EndoCockpitRegistryKindV0,
	index: number,
	id: string | null,
): EndoCockpitRefV0 {
	return { domain: "harness-registry", attachment, kind, index, id: id === null ? null : alias.id(id) };
}

export function claimV0<T>(
	basis: Exclude<EndoCockpitClaimV0<T>["basis"], "unavailable">,
	value: T,
	refs: EndoCockpitRefV0[],
): EndoCockpitClaimV0<T> {
	return { basis, value, refs };
}

export function unavailableV0<T>(reason: string, refs: EndoCockpitRefV0[] = []): EndoCockpitClaimV0<T> {
	return { basis: "unavailable", reason, refs };
}

export function noteV0(code: EndoCockpitNoteCodeV0, refs: EndoCockpitRefV0[] = []): EndoCockpitNoteV0 {
	return { code, refs };
}

/**
 * The records of one kind that belong to this registry's attachment, first of each id. A record naming another
 * attachment, or repeating an id, is not presented as a record of this registry; each is noted with its reference. The
 * durable registry refuses both on open, so this only matters for input that did not come from it.
 *
 * Ids are unique across ALL kinds of a registry, so the first-of-each-id ledger is built over every kind in
 * ENDO_COCKPIT_REGISTRY_KINDS_V0 order, whichever kinds this projection presents: which record of two sharing an id is the
 * repeat then does not depend on the projection asked. Only the records of the requested kind are returned and noted.
 * (The input lists are per kind, so their append order across kinds is not known; the kind order stands in for it.)
 */
export function cleanRegistryRecordsV0<K extends EndoCockpitRegistryKindV0>(
	source: EndoCockpitRegistrySourceV0,
	alias: EndoCockpitAliasesV0,
	kind: K,
	records: EndoCockpitRegistryRecordsV0,
	notes: EndoCockpitNoteV0[],
): EndoCockpitIndexedV0<EndoCockpitRegistryRecordsV0[K][number]>[] {
	const kept: EndoCockpitIndexedV0<EndoCockpitRegistryRecordsV0[K][number]>[] = [];
	const ids = new Set<string>();
	for (const each of ENDO_COCKPIT_REGISTRY_KINDS_V0) {
		(records[each] as readonly { attachment: string; id?: string }[]).forEach((record, index) => {
			if (record.attachment !== source.attachment) {
				if (each === kind)
					notes.push(
						noteV0("foreign-attachment-record", [
							registryRefV0(alias, source.attachment, kind, index, record.id ?? null),
						]),
					);
				return;
			}
			const id = record.id ?? null;
			if (id !== null) {
				if (ids.has(id)) {
					if (each === kind)
						notes.push(noteV0("duplicate-record-id", [registryRefV0(alias, source.attachment, kind, index, id)]));
					return;
				}
				ids.add(id);
			}
			if (each === kind) kept.push({ record: record as EndoCockpitRegistryRecordsV0[K][number], index });
		});
	}
	return kept;
}

/**
 * The watermark a registry read advertises for these records under this key: the one construction, shared by the reader (which
 * makes it) and the projectors (which check the input against it), so the two cannot drift. `null` when the registry could not
 * be opened; records that are `null` for another reason (absent) commit to nothing, as do empty lists. Nonempty records are
 * committed to under the key only, over ALL five kinds in append order, whichever a projection presents.
 */
export function registryWatermarkV0(
	key: EndoDigestKeyV0,
	state: EndoCockpitSourceConditionV0["state"],
	records: EndoCockpitRegistryRecordsV0 | null,
): EndoCockpitRegistryWatermarkV0 | null {
	const counts = { fingerprint: 0, change: 0, evidence: 0, state: 0, notification: 0 };
	const lastIds: Record<EndoCockpitRegistryKindV0, string | null> = {
		fingerprint: null,
		change: null,
		evidence: null,
		state: null,
		notification: null,
	};
	if (records === null) {
		if (state === "unopenable") return null;
		return { counts, lastIds, contentDigest: sha256HexV0(canonicalEndoJsonV0({})), keyId: key.keyId };
	}
	const alias = cockpitAliasesV0(key);
	const content: Record<string, unknown[]> = {};
	for (const kind of ENDO_COCKPIT_REGISTRY_KINDS_V0) {
		const list = records[kind] as readonly { id?: string }[];
		counts[kind] = list.length;
		const last = list.at(-1)?.id;
		lastIds[kind] = last === undefined ? null : alias.id(last);
		content[kind] = [...list];
	}
	return {
		counts,
		lastIds,
		// No records commit to nothing (a fixed constant); records are committed to under the key only.
		contentDigest: ENDO_COCKPIT_REGISTRY_KINDS_V0.every((kind) => counts[kind] === 0)
			? sha256HexV0(canonicalEndoJsonV0(content))
			: cockpitTokenV0(key, ENDO_COCKPIT_TOKEN_PURPOSES_V0.registryContent, { content }),
		keyId: key.keyId,
	};
}

/**
 * Admits one registry projection input, or refuses it with a TypeError (a usage error: the input contradicts itself). The
 * source was read under a key (its watermark records the key's id): a projection under another would alias differently from
 * the watermark's own ids. And the position the source advertises must be the position of the records supplied: counts, last
 * ids and content digest of ALL five kinds, whichever the projection presents, and a condition that can hold them. (Foreign or
 * repeated records are not refused here: they are cleaned and noted, which a coherent defensive input may ask for.)
 * Returns the aliases the projection uses.
 */
export function admitRegistryInputV0(input: EndoCockpitRegistryInputV0, key: EndoDigestKeyV0): EndoCockpitAliasesV0 {
	const { source, records } = input;
	if (source.watermark !== null && source.watermark.keyId !== key.keyId)
		throw new TypeError("the digest key is not the key the source was read under");
	const state = source.condition.state;
	// Records exist exactly when the registry was opened, and then the state says whether any were found.
	const opened = state === "empty" || state === "readable" || state === "degraded";
	if (opened !== (records !== null)) throw new TypeError("the source condition disagrees with the records supplied");
	if (records !== null) {
		const total = ENDO_COCKPIT_REGISTRY_KINDS_V0.reduce((sum, kind) => sum + records[kind].length, 0);
		if ((state === "empty" && total !== 0) || (state === "readable" && total === 0))
			throw new TypeError("the source condition disagrees with the records supplied");
	}
	const expected = registryWatermarkV0(key, state, records);
	if (canonicalEndoJsonV0(expected) !== canonicalEndoJsonV0(source.watermark))
		throw new TypeError("the source watermark disagrees with the records supplied");
	return cockpitAliasesV0(key);
}
