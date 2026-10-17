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
import { ENDO_COCKPIT_WITHHELD_TEXT_V0 } from "../../protocol/cockpit.ts";
import type {
	EndoCapabilityEvidenceV0,
	EndoCapabilityStateV0,
	EndoHarnessChangeV0,
	EndoHarnessFingerprintV0,
	EndoHarnessNotificationV0,
} from "../../protocol/harness.ts";

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

/**
 * Text that looks like it carries a local path, a network address or a credential. A heuristic for free text a record
 * author wrote (a reason, a limitation, a title, a runtime-reported string): it is not a secret scanner and a pass does
 * not certify the text safe, but what it flags is withheld whole, never partly rewritten, so the result is deterministic.
 * Prose that merely contains a slash ("input/output") is not flagged; a token that starts with one, or a drive letter,
 * a home shorthand, a URL or a known credential shape, is.
 */
const SENSITIVE_TEXT: readonly RegExp[] = [
	/(?:^|[\s"'`([{=:,;<])(?:\/|~\/|\.{1,2}\/)[^\s]/,
	/\b[A-Za-z]:[\\/]/,
	/\\\\[^\s\\]+\\/,
	/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S/,
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/,
	/\bxox[abprs]-[A-Za-z0-9-]{8,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
	/\b(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[=:]\s*\S{4,}/i,
];

export function looksSensitiveTextV0(text: string): boolean {
	return SENSITIVE_TEXT.some((pattern) => pattern.test(text));
}

/** The text itself, or the fixed withheld text when it looks sensitive. */
export function presentableTextV0(text: string): string {
	return looksSensitiveTextV0(text) ? ENDO_COCKPIT_WITHHELD_TEXT_V0 : text;
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
	return { domain: "harness-registry", attachment, kind, index, id };
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
