// Compare discovery is presentation, not durable evidence. Tokens identify a recording only through server-side verification;
// a displayed session (including a generated alias) is never an opaque selector's lookup key.
import { isEndoCockpitPublicIdV0 } from "./cockpit-fields.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";

export const ENDO_COCKPIT_COMPARE_CANDIDATES_SCHEMA_V0 = "endo.cockpit-compare-candidates.v0";
export const ENDO_COCKPIT_COMPARE_CANDIDATES_PROJECTION_V0 = "cockpit-compare-candidates.1";
export const ENDO_COCKPIT_CANDIDATE_PAGE_SIZE_V0 = 100;
export const ENDO_COCKPIT_CANDIDATE_MAX_TOTAL_V0 = 10_000;

export interface EndoCockpitCompareCandidateV0 {
	source: "pi" | "dsh";
	/** Display only. Never pass an alias to the raw-coordinate comparison endpoint. */
	session: string;
	label: "Pi recording" | "DSH recording";
	eligibility: "selectable" | "ambiguous" | "insufficient";
	/** Opaque, source- and generation-bound; null exactly when not selectable. */
	selector: string | null;
}

export interface EndoCockpitCompareCandidatesV0 {
	schemaVersion: typeof ENDO_COCKPIT_COMPARE_CANDIDATES_SCHEMA_V0;
	projectionVersion: typeof ENDO_COCKPIT_COMPARE_CANDIDATES_PROJECTION_V0;
	/** Keyed token of the complete verified log observation; not the original source file's current state. */
	generation: string;
	candidates: EndoCockpitCompareCandidateV0[];
	page: { offset: number; total: number; hasMore: boolean; nextCursor: string | null };
}

export const isEndoCockpitCandidateSelectorV0 = (value: unknown): value is string =>
	typeof value === "string" && /^c1-[0-9a-f]{64}$/.test(value);

/** Syntax only: authentication against the current verified generation happens after the store read. */
export function parseEndoCockpitCandidateCursorV0(value: unknown): { offset: number; mac: string } | null {
	if (typeof value !== "string") return null;
	const match = /^p1-([1-9][0-9]{0,3})-([0-9a-f]{64})$/.exec(value);
	if (match === null) return null;
	const offset = Number(match[1]);
	return offset % ENDO_COCKPIT_CANDIDATE_PAGE_SIZE_V0 === 0 ? { offset, mac: match[2]! } : null;
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) return false;
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

/** Closed wire shape and internal consistency only: no claim to authenticate tokens or verify source evidence. */
export function validateEndoCockpitCompareCandidatesV0(value: unknown): EndoCockpitCompareCandidatesV0 | null {
	if (
		!exact(value, ["schemaVersion", "projectionVersion", "generation", "candidates", "page"]) ||
		value.schemaVersion !== ENDO_COCKPIT_COMPARE_CANDIDATES_SCHEMA_V0 ||
		value.projectionVersion !== ENDO_COCKPIT_COMPARE_CANDIDATES_PROJECTION_V0 ||
		typeof value.generation !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.generation) ||
		!Array.isArray(value.candidates) ||
		value.candidates.length > ENDO_COCKPIT_CANDIDATE_PAGE_SIZE_V0 ||
		!exact(value.page, ["offset", "total", "hasMore", "nextCursor"])
	)
		return null;
	const { offset, total, hasMore, nextCursor } = value.page;
	if (
		typeof offset !== "number" ||
		typeof total !== "number" ||
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(total) ||
		offset < 0 ||
		total < 0 ||
		total > ENDO_COCKPIT_CANDIDATE_MAX_TOTAL_V0 ||
		offset % ENDO_COCKPIT_CANDIDATE_PAGE_SIZE_V0 !== 0 ||
		(offset > 0 && offset >= total) ||
		value.candidates.length !== Math.min(ENDO_COCKPIT_CANDIDATE_PAGE_SIZE_V0, total - offset) ||
		hasMore !== offset + value.candidates.length < total
	)
		return null;
	if (hasMore) {
		if (parseEndoCockpitCandidateCursorV0(nextCursor)?.offset !== offset + value.candidates.length) return null;
	} else if (nextCursor !== null) return null;
	let previous = "";
	const selectors = new Set<string>();
	for (const row of value.candidates) {
		if (
			!exact(row, ["source", "session", "label", "eligibility", "selector"]) ||
			(row.source !== "pi" && row.source !== "dsh") ||
			typeof row.session !== "string" ||
			!isEndoCockpitPublicIdV0(row.session, "session") ||
			row.label !== (row.source === "pi" ? "Pi recording" : "DSH recording") ||
			(row.eligibility !== "selectable" && row.eligibility !== "ambiguous" && row.eligibility !== "insufficient") ||
			(row.eligibility === "ambiguous" && row.source !== "pi")
		)
			return null;
		const order = `${row.source}\u0000${row.session}`;
		if (order <= previous) return null;
		previous = order;
		if (row.eligibility === "selectable") {
			if (!isEndoCockpitCandidateSelectorV0(row.selector) || selectors.has(row.selector)) return null;
			selectors.add(row.selector);
		} else if (row.selector !== null) return null;
	}
	return value as unknown as EndoCockpitCompareCandidatesV0;
}
