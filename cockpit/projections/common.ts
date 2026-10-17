// Shared pieces of the pure cockpit projections: input shapes, reference and claim builders, and the one comparison used
// wherever the contract promises "code-unit order". Nothing here reads a file, a clock or the environment.

import type {
	EndoCockpitClaimV0,
	EndoCockpitNoteCodeV0,
	EndoCockpitNoteV0,
	EndoCockpitRefV0,
	EndoCockpitRegistryKindV0,
	EndoCockpitRegistrySourceV0,
} from "../../protocol/cockpit.ts";
import {
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	endoCockpitTextUnsafeV0,
	isEndoCockpitPublicIdV0,
} from "../../protocol/cockpit-fields.ts";
import type {
	EndoCapabilityEvidenceV0,
	EndoCapabilityStateV0,
	EndoHarnessChangeV0,
	EndoHarnessFingerprintV0,
	EndoHarnessNotificationV0,
} from "../../protocol/harness.ts";
import { parseEndoIdentifierV0 } from "../../protocol/identity.ts";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

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

/** The text itself, or the fixed withheld text when it looks sensitive. The record's own bound applies, not a cut. */
export function presentableTextV0(text: string): string {
	return endoCockpitTextUnsafeV0(text) ? ENDO_COCKPIT_WITHHELD_TEXT_V0 : text;
}

/**
 * A dotted kind (a capability, an event kind) as the cockpit presents it: as it is, or, when the text policy flags it, a
 * deterministic placeholder of the same grammar (`withheld-` and 32 hex digits of its sha256). A kind is grammar-valid
 * whatever it says, so the grammar alone does not keep a credential-shaped one out of a result.
 */
export function kindLabelV0(kind: string): string {
	return endoCockpitTextUnsafeV0(kind) ? `withheld-${sha256HexV0(kind).slice(0, 32)}` : kind;
}

/**
 * An identifier as the cockpit presents it. An identifier of the shape identifiers have (isEndoCockpitPublicIdV0) is
 * presented as it is. Any other is replaced by a deterministic alias in the same namespace, `endo.<kind>.withheld-` and
 * 32 hex digits of the sha256 of the identifier: the same identifier gives the same alias everywhere, so every reference
 * relationship (an event and the events derived from it, a state and its fingerprint) is kept, and the underlying
 * identifier is neither changed nor recoverable from the alias. A low-entropy secret could be guessed and confirmed
 * against the alias; that is not claimed away.
 */
export function publicIdV0(id: string): string {
	if (isEndoCockpitPublicIdV0(id)) return id;
	const kind = parseEndoIdentifierV0(id)?.kind ?? "evidence";
	return `endo.${kind}.withheld-${sha256HexV0(id).slice(0, 32)}`;
}

/** Order two strings by UTF-16 code unit, independent of the host's locale. */
export function compareCodeUnitsV0(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function registryRefV0(
	attachment: string,
	kind: EndoCockpitRegistryKindV0,
	index: number,
	id: string | null,
): EndoCockpitRefV0 {
	return { domain: "harness-registry", attachment, kind, index, id: id === null ? null : publicIdV0(id) };
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
 */
export function cleanRegistryRecordsV0<
	K extends EndoCockpitRegistryKindV0,
	T extends { attachment: string; id?: string },
>(
	source: EndoCockpitRegistrySourceV0,
	kind: K,
	records: readonly T[],
	notes: EndoCockpitNoteV0[],
): EndoCockpitIndexedV0<T>[] {
	const kept: EndoCockpitIndexedV0<T>[] = [];
	const ids = new Set<string>();
	records.forEach((record, index) => {
		const id = record.id ?? null;
		if (record.attachment !== source.attachment) {
			notes.push(noteV0("foreign-attachment-record", [registryRefV0(source.attachment, kind, index, id)]));
			return;
		}
		if (id !== null) {
			if (ids.has(id)) {
				notes.push(noteV0("duplicate-record-id", [registryRefV0(source.attachment, kind, index, id)]));
				return;
			}
			ids.add(id);
		}
		kept.push({ record, index });
	});
	return kept;
}
