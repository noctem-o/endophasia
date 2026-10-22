// The cockpit's trajectory-comparison presentation v0: what an operator may be shown about two recorded trajectories compared.
//
// This is a PROJECTION of `endo.trajectory-comparison.v1` (protocol/trajectory.ts), which stays the one authority on what the
// two recordings establish. Nothing here judges, aligns or infers: the projection (cockpit/projections/trajectory-comparison.ts)
// copies the comparator's verdicts into a browser-safe shape and withholds what a browser must not receive. Like the other
// cockpit read models it is not stored, not an authority, and not in the durable schema catalogue.
//
// What it keeps, because the comparator's rules say so:
// - Layers are aligned by position WITHIN each layer. There is no cross-layer order of divergence and no event-by-event
//   correspondence between the two sessions, so this record has neither: no "first divergence overall", no overall verdict, no
//   event pairing. A reader asks about "the first differing tool call", "the first differing tool result", and so on.
// - EXACT / DIVERGED / UNAVAILABLE stay three states. UNAVAILABLE carries its reason; an entry past a side's end is
//   `present: false`, never a null or empty entry; a delta that cannot be established is `UNAVAILABLE`, never 0.
// - Tool calls (what the agent chose) and tool results (what the world answered) stay two layers. `toolCallsAgainstInputs` is
//   an ordering of positions, not a cause: a different result before a different call does not show the result caused it.
// - Usage is what the runtime reported and timing is what the observer measured; both are b minus a, neither is a verdict.
// - Mixed sources are listed in `flags`; an empty list means no RECORDED difference, not a controlled experiment.
//
// What it withholds (the cockpit presentation boundary, protocol/cockpit-fields.ts):
// - Store paths (`provenance`) are not carried. Session ids are presented as the cockpit presents any id (itself when admitted,
//   else a keyed alias).
// - A plain sha256 that commits to content the cockpit withholds (the recorded events, the trajectory, the comparison, a runtime
//   fingerprint or configuration digest, an unrecognised lifecycle payload, a failure cause) is never published: a keyed token
//   stands in, equal for equal values under one key (`keyId`). So tokens say "same" or "different" and nothing else, and are
//   not the digests `endo trajectory diff` prints.
// - A keyed digest of tool arguments or results is already an HMAC; it is shown as recorded, with its key id, only when the key
//   id is one the cockpit admits (isEndoCockpitDigestKeyIdV0), and the pair is shown together or not at all.
// - Free text (versions, models, stop reasons, reasons) is shown only when the text policy admits it whole; otherwise a keyed
//   token of it, so two withheld values that differ still read as different.
// - Facts of lifecycle and outcome entries are a flat, bounded list of (path, scalar); nothing beyond it is carried.
//
// The protocol imports only the protocol.

import {
	endoCockpitTextPresentableV0,
	isEndoCockpitDigestKeyIdV0,
	isEndoCockpitPublicIdV0,
	isEndoCockpitPublicKindV0,
} from "./cockpit-fields.ts";
import { ENDO_KEYED_DIGEST_VALUE_PATTERN_V0 } from "./keyed-digest-shape.ts";
import { isEndoLifecycleKindV0 } from "./session-lifecycle.ts";
import { ENDO_TRAJECTORY_COMPARISON_RULES_V0 } from "./trajectory.ts";

export const ENDO_COCKPIT_TRAJECTORY_COMPARISON_SCHEMA_V0 = "endo.cockpit-trajectory-comparison.v0";
/** Bumped when what the projection computes changes. It is tied to the comparator's rules version (`comparisonRules`). */
export const ENDO_COCKPIT_TRAJECTORY_COMPARISON_PROJECTION_V0 = "cockpit-trajectory-comparison.1";

/** The most (path, value) items of one entry's facts; the rest are counted in `omitted`. */
export const ENDO_COCKPIT_COMPARISON_MAX_FACTS_V0 = 32;
/** The deepest nesting of a fact's path. */
export const ENDO_COCKPIT_COMPARISON_MAX_FACT_DEPTH_V0 = 4;

/** Free text as presented: whole, or withheld by the text policy and replaced by a keyed token of it. */
export type EndoCockpitComparisonTextV0 =
	| { kind: "text"; text: string }
	| { kind: "withheld"; token: string }
	/** A value that is itself a digest (a runtime fingerprint, a hash committing to withheld content), as a keyed token. */
	| { kind: "token"; token: string };

export type EndoCockpitComparisonReportedV0<T> =
	| { status: "reported"; value: T }
	| { status: "UNAVAILABLE"; reason: EndoCockpitComparisonTextV0 };

/** A keyed digest of tool arguments or results: as recorded, withheld when its key id is not one the cockpit admits, or not recorded. */
export type EndoCockpitComparisonDigestV0 =
	| { status: "reported"; keyId: string; value: string }
	| { status: "withheld" }
	| { status: "UNAVAILABLE"; reason: EndoCockpitComparisonTextV0 };

export type EndoCockpitComparisonFactValueV0 = null | boolean | number | EndoCockpitComparisonTextV0;

/** An entry's facts, flattened: dotted paths in code-unit order, each a scalar. `omitted` counts what the bounds left out. */
export interface EndoCockpitComparisonFactsV0 {
	items: { path: string; value: EndoCockpitComparisonFactValueV0 }[];
	omitted: number;
}

export interface EndoCockpitComparisonLifecycleEntryV0 {
	/** A lifecycle kind this version defines, else a keyed alias of the kind. */
	kind: string;
	recognized: boolean;
	facts: EndoCockpitComparisonFactsV0;
}

export interface EndoCockpitComparisonToolCallEntryV0 {
	run: number | null;
	turn: number | null;
	name: EndoCockpitComparisonReportedV0<EndoCockpitComparisonTextV0>;
	args: EndoCockpitComparisonDigestV0;
}

export interface EndoCockpitComparisonToolResultEntryV0 {
	run: number | null;
	turn: number | null;
	name: EndoCockpitComparisonReportedV0<EndoCockpitComparisonTextV0>;
	status: EndoCockpitComparisonReportedV0<"ok" | "error">;
	result: EndoCockpitComparisonDigestV0;
}

export const ENDO_COCKPIT_COMPARISON_OUTCOMES_V0 = [
	"completed",
	"failed",
	"aborted",
	"interrupted",
	"unclassified",
	"open",
] as const;
export type EndoCockpitComparisonOutcomeKindV0 = (typeof ENDO_COCKPIT_COMPARISON_OUTCOMES_V0)[number];

export interface EndoCockpitComparisonOutcomeEntryV0 {
	run: number;
	outcome: EndoCockpitComparisonOutcomeKindV0;
	turns: number;
	stopReason: EndoCockpitComparisonReportedV0<EndoCockpitComparisonTextV0>;
	stopRequested: boolean;
	cause: EndoCockpitComparisonFactsV0;
}

/** An entry at a position, or the fact that a side has no entry there (it is shorter). Never a null entry. */
export type EndoCockpitComparisonSlotV0<E> = { present: false } | { present: true; entry: E };

/** Why a position could not be verified, as a code; the comparator's wording is not carried. */
export type EndoCockpitComparisonUnverifiedV0 =
	| { code: "digest-not-recorded"; sides: "one" | "both" }
	| { code: "digest-domains-differ"; domains: [EndoCockpitComparisonTextV0, EndoCockpitComparisonTextV0] }
	| { code: "unrecognized"; text: EndoCockpitComparisonTextV0 };

export type EndoCockpitComparisonVerdictV0<E> =
	| { status: "EXACT"; length: number }
	| {
			status: "DIVERGED";
			/** The first differing position within THIS layer. It says nothing about the position in another layer. */
			index: number;
			commonPrefix: number;
			lengths: { a: number; b: number };
			a: EndoCockpitComparisonSlotV0<E>;
			b: EndoCockpitComparisonSlotV0<E>;
	  }
	| {
			status: "UNAVAILABLE";
			/** Why each side did not report the layer (null: that side did). */
			sides: { a: EndoCockpitComparisonTextV0 | null; b: EndoCockpitComparisonTextV0 | null };
			/** When both sides reported it: the positions that could not be verified. */
			unverified: { index: number; reason: EndoCockpitComparisonUnverifiedV0 }[];
			lengths: { a: number; b: number } | null;
	  };

export const ENDO_COCKPIT_COMPARISON_AGAINST_INPUTS_REASONS_V0 = [
	"calls-unavailable",
	"calls-identical",
	"calls-unverified",
	"results-unavailable-or-unverified",
	"calls-diverged-results-identical",
	"order-unknown",
	"call-in-later-turn-than-divergent-result",
	"call-not-after-divergent-result",
] as const;
export type EndoCockpitComparisonAgainstInputsReasonV0 =
	(typeof ENDO_COCKPIT_COMPARISON_AGAINST_INPUTS_REASONS_V0)[number];

export interface EndoCockpitComparisonPositionV0 {
	index: number;
	run: number | null;
	turn: number | null;
}

/**
 * An ordering of positions in two layers, not a cause. `true` means no call differed before the first differing input could
 * have been seen; it does not say the input explains a later difference, and `false`/`null` do not say it does not.
 */
export interface EndoCockpitComparisonAgainstInputsV0 {
	firstDivergentResult: EndoCockpitComparisonPositionV0 | null;
	firstDivergentCall: EndoCockpitComparisonPositionV0 | null;
	callsIdenticalUpToFirstDivergentInput: boolean | null;
	reason: EndoCockpitComparisonAgainstInputsReasonV0;
}

/** A difference that can be established, or the fact that it cannot. Never 0 for "unknown". */
export type EndoCockpitComparisonQuantityV0 = { status: "DELTA"; value: number } | { status: "UNAVAILABLE" };

export const ENDO_COCKPIT_COMPARISON_TOKEN_FIELDS_V0 = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"totalTokens",
	"reasoning",
	"costTotal",
] as const;
export type EndoCockpitComparisonTokenFieldV0 = (typeof ENDO_COCKPIT_COMPARISON_TOKEN_FIELDS_V0)[number];

export type EndoCockpitComparisonTokenDeltasV0 =
	| { status: "DELTAS"; fields: { [F in EndoCockpitComparisonTokenFieldV0]?: EndoCockpitComparisonQuantityV0 } }
	| { status: "UNAVAILABLE" };

export type EndoCockpitComparisonUsageV0 =
	| { status: "UNAVAILABLE"; sides: { a: EndoCockpitComparisonTextV0 | null; b: EndoCockpitComparisonTextV0 | null } }
	| {
			status: "DELTAS";
			basis: "runtime-reported";
			direction: "b-minus-a";
			runs: { run: number; present: { a: boolean; b: boolean }; tokens: EndoCockpitComparisonTokenDeltasV0 }[];
			totals: EndoCockpitComparisonTokenDeltasV0;
	  };

export type EndoCockpitComparisonTimingV0 =
	| { status: "UNAVAILABLE"; sides: { a: EndoCockpitComparisonTextV0 | null; b: EndoCockpitComparisonTextV0 | null } }
	| {
			status: "DELTAS";
			basis: "observer-measured";
			clock: "observer";
			direction: "b-minus-a";
			runs: { run: number; present: { a: boolean; b: boolean }; wallMs: EndoCockpitComparisonQuantityV0 }[];
			totals: { wallMs: EndoCockpitComparisonQuantityV0 };
	  };

export const ENDO_COCKPIT_COMPARISON_FLAG_KINDS_V0 = [
	"runtime-fingerprint-differs",
	"runtime-version-differs",
	"mapping-differs",
	"digest-domain-differs",
	"configuration-differs",
	"configured-model-differs",
	"reported-model-differs",
	"projection-differs",
] as const;
export type EndoCockpitComparisonFlagKindV0 = (typeof ENDO_COCKPIT_COMPARISON_FLAG_KINDS_V0)[number];

/** One side's distinct values of an environment facet; null is a value the recording did not report. */
export type EndoCockpitComparisonFlagSideV0 = { [facet: string]: (EndoCockpitComparisonTextV0 | null)[] };

export interface EndoCockpitComparisonFlagV0 {
	kind: EndoCockpitComparisonFlagKindV0;
	a: EndoCockpitComparisonFlagSideV0;
	b: EndoCockpitComparisonFlagSideV0;
}

export interface EndoCockpitComparisonSideV0 {
	/** The endo session coordinate, as the cockpit presents an id. */
	session: string;
	/** Keyed token of the digest of the events read. */
	eventsToken: string;
	/** Keyed token of the trajectory's digest. */
	trajectoryToken: string;
}

export interface EndoCockpitTrajectoryComparisonV0 {
	schemaVersion: typeof ENDO_COCKPIT_TRAJECTORY_COMPARISON_SCHEMA_V0;
	projectionVersion: typeof ENDO_COCKPIT_TRAJECTORY_COMPARISON_PROJECTION_V0;
	/** The digest key every token in this record was made under. Tokens under another key are not comparable. */
	keyId: string;
	/** The comparator's rules version this record presents (`trajectory-comparison.3`). */
	comparisonRules: string;
	/** Keyed token of the source comparison's digest: ties this record to one comparison without publishing the digest. */
	comparisonToken: string;
	a: EndoCockpitComparisonSideV0;
	b: EndoCockpitComparisonSideV0;
	flags: EndoCockpitComparisonFlagV0[];
	toolCallsAgainstInputs: EndoCockpitComparisonAgainstInputsV0;
	layers: {
		lifecycle: EndoCockpitComparisonVerdictV0<EndoCockpitComparisonLifecycleEntryV0>;
		toolCalls: EndoCockpitComparisonVerdictV0<EndoCockpitComparisonToolCallEntryV0>;
		toolResults: EndoCockpitComparisonVerdictV0<EndoCockpitComparisonToolResultEntryV0>;
		outcome: EndoCockpitComparisonVerdictV0<EndoCockpitComparisonOutcomeEntryV0>;
		usage: EndoCockpitComparisonUsageV0;
		timing: EndoCockpitComparisonTimingV0;
	};
}

// --- validation -------------------------------------------------------------------------------------------------------

type R = Record<string, unknown>;

const isRecord = (value: unknown): value is R => typeof value === "object" && value !== null && !Array.isArray(value);
const closed = (value: R, required: readonly string[], optional: readonly string[] = []): boolean =>
	Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) &&
	required.every((key) => Object.hasOwn(value, key));
const HEX64 = /^[0-9a-f]{64}$/;
const isToken = (value: unknown): boolean => typeof value === "string" && HEX64.test(value);
const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositionOrNull = (value: unknown): boolean => value === null || (isCount(value) && value >= 1);
const FACT_SEGMENT = "(?:[A-Za-z][A-Za-z0-9_-]{0,39}|[0-9]{1,3})";
const FACT_PATH = new RegExp(
	`^[A-Za-z][A-Za-z0-9_-]{0,39}(?:\\.${FACT_SEGMENT}){0,${ENDO_COCKPIT_COMPARISON_MAX_FACT_DEPTH_V0 - 1}}$`,
);

function isText(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "text")
		return (
			closed(value, ["kind", "text"]) && typeof value.text === "string" && endoCockpitTextPresentableV0(value.text)
		);
	if (value.kind === "withheld" || value.kind === "token")
		return closed(value, ["kind", "token"]) && isToken(value.token);
	return false;
}

function isReported(value: unknown, inner: (item: unknown) => boolean): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "reported") return closed(value, ["status", "value"]) && inner(value.value);
	if (value.status === "UNAVAILABLE") return closed(value, ["status", "reason"]) && isText(value.reason);
	return false;
}

function isDigest(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "reported")
		return (
			closed(value, ["status", "keyId", "value"]) &&
			isEndoCockpitDigestKeyIdV0(value.keyId) &&
			typeof value.value === "string" &&
			ENDO_KEYED_DIGEST_VALUE_PATTERN_V0.test(value.value)
		);
	if (value.status === "withheld") return closed(value, ["status"]);
	if (value.status === "UNAVAILABLE") return closed(value, ["status", "reason"]) && isText(value.reason);
	return false;
}

function isFacts(value: unknown): boolean {
	if (!isRecord(value) || !closed(value, ["items", "omitted"]) || !isCount(value.omitted)) return false;
	const items = value.items;
	if (!Array.isArray(items) || items.length > ENDO_COCKPIT_COMPARISON_MAX_FACTS_V0) return false;
	let previous: string | null = null;
	for (const item of items) {
		if (!isRecord(item) || !closed(item, ["path", "value"]) || typeof item.path !== "string") return false;
		if (!FACT_PATH.test(item.path) || (previous !== null && !(previous < item.path))) return false;
		previous = item.path;
		const v = item.value;
		const scalar = v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
		if (!scalar && !isText(v)) return false;
	}
	return true;
}

const isLifecycleEntry = (value: unknown): boolean =>
	isRecord(value) &&
	closed(value, ["kind", "recognized", "facts"]) &&
	typeof value.kind === "string" &&
	typeof value.recognized === "boolean" &&
	// A recognised entry names a kind this version defines; an unrecognised one only the alias of its kind.
	(value.recognized
		? isEndoLifecycleKindV0(value.kind)
		: !isEndoLifecycleKindV0(value.kind) && isEndoCockpitPublicKindV0(value.kind)) &&
	isFacts(value.facts);

const isNameReported = (value: unknown): boolean => isReported(value, isText);

const isToolCallEntry = (value: unknown): boolean =>
	isRecord(value) &&
	closed(value, ["run", "turn", "name", "args"]) &&
	isPositionOrNull(value.run) &&
	isPositionOrNull(value.turn) &&
	isNameReported(value.name) &&
	isDigest(value.args);

const isToolResultEntry = (value: unknown): boolean =>
	isRecord(value) &&
	closed(value, ["run", "turn", "name", "status", "result"]) &&
	isPositionOrNull(value.run) &&
	isPositionOrNull(value.turn) &&
	isNameReported(value.name) &&
	isReported(value.status, (status) => status === "ok" || status === "error") &&
	isDigest(value.result);

const isOutcomeEntry = (value: unknown): boolean =>
	isRecord(value) &&
	closed(value, ["run", "outcome", "turns", "stopReason", "stopRequested", "cause"]) &&
	isCount(value.run) &&
	value.run >= 1 &&
	(ENDO_COCKPIT_COMPARISON_OUTCOMES_V0 as readonly unknown[]).includes(value.outcome) &&
	isCount(value.turns) &&
	isNameReported(value.stopReason) &&
	typeof value.stopRequested === "boolean" &&
	isFacts(value.cause);

function isUnverified(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.code === "digest-not-recorded")
		return closed(value, ["code", "sides"]) && (value.sides === "one" || value.sides === "both");
	if (value.code === "digest-domains-differ")
		return (
			closed(value, ["code", "domains"]) &&
			Array.isArray(value.domains) &&
			value.domains.length === 2 &&
			value.domains.every(isText)
		);
	if (value.code === "unrecognized") return closed(value, ["code", "text"]) && isText(value.text);
	return false;
}

const isLengths = (value: unknown): value is { a: number; b: number } =>
	isRecord(value) && closed(value, ["a", "b"]) && isCount(value.a) && isCount(value.b);

const isSides = (value: unknown): value is { a: unknown; b: unknown } =>
	isRecord(value) &&
	closed(value, ["a", "b"]) &&
	(value.a === null || isText(value.a)) &&
	(value.b === null || isText(value.b));

function isVerdict(value: unknown, isEntry: (entry: unknown) => boolean): boolean {
	if (!isRecord(value)) return false;
	switch (value.status) {
		case "EXACT":
			return closed(value, ["status", "length"]) && isCount(value.length);
		case "DIVERGED": {
			if (!closed(value, ["status", "index", "commonPrefix", "lengths", "a", "b"])) return false;
			if (!isCount(value.index) || value.commonPrefix !== value.index || !isLengths(value.lengths)) return false;
			const lengths = value.lengths;
			// A slot is present exactly where its side has an entry; a position both sides lack is no divergence.
			const slot = (item: unknown, length: number): boolean => {
				if (!isRecord(item) || typeof item.present !== "boolean") return false;
				if ((value.index as number) < length !== item.present) return false;
				return item.present ? closed(item, ["present", "entry"]) && isEntry(item.entry) : closed(item, ["present"]);
			};
			if (!slot(value.a, lengths.a) || !slot(value.b, lengths.b)) return false;
			return (value.index as number) < Math.max(lengths.a, lengths.b);
		}
		case "UNAVAILABLE": {
			if (!closed(value, ["status", "sides", "unverified", "lengths"]) || !isSides(value.sides)) return false;
			const unverified = value.unverified;
			if (
				!Array.isArray(unverified) ||
				!unverified.every(
					(item) =>
						isRecord(item) &&
						closed(item, ["index", "reason"]) &&
						isCount(item.index) &&
						isUnverified(item.reason),
				)
			)
				return false;
			const missing = value.sides.a !== null || value.sides.b !== null;
			// Either a side did not report the layer (no lengths, nothing to verify), or both did and some position is unverified.
			return missing
				? value.lengths === null && unverified.length === 0
				: isLengths(value.lengths) && unverified.length > 0;
		}
		default:
			return false;
	}
}

const isPosition = (value: unknown): boolean =>
	value === null ||
	(isRecord(value) &&
		closed(value, ["index", "run", "turn"]) &&
		isCount(value.index) &&
		isPositionOrNull(value.run) &&
		isPositionOrNull(value.turn));

const isQuantity = (value: unknown): boolean => {
	if (!isRecord(value)) return false;
	if (value.status === "DELTA")
		return closed(value, ["status", "value"]) && typeof value.value === "number" && Number.isFinite(value.value);
	return value.status === "UNAVAILABLE" && closed(value, ["status"]);
};

const isTokenDeltas = (value: unknown): boolean => {
	if (!isRecord(value)) return false;
	if (value.status === "UNAVAILABLE") return closed(value, ["status"]);
	return (
		value.status === "DELTAS" &&
		closed(value, ["status", "fields"]) &&
		isRecord(value.fields) &&
		Object.entries(value.fields).every(
			([field, quantity]) =>
				(ENDO_COCKPIT_COMPARISON_TOKEN_FIELDS_V0 as readonly string[]).includes(field) && isQuantity(quantity),
		)
	);
};

const isPresent = (value: unknown): boolean =>
	isRecord(value) && closed(value, ["a", "b"]) && typeof value.a === "boolean" && typeof value.b === "boolean";

function isDeltaRuns(value: unknown, field: string, isDelta: (item: unknown) => boolean): boolean {
	if (!Array.isArray(value)) return false;
	return value.every(
		(item, index) =>
			isRecord(item) &&
			closed(item, ["run", "present", field]) &&
			item.run === index + 1 &&
			isPresent(item.present) &&
			isDelta(item[field]),
	);
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "UNAVAILABLE")
		return (
			closed(value, ["status", "sides"]) &&
			isSides(value.sides) &&
			(value.sides.a !== null || value.sides.b !== null)
		);
	return (
		value.status === "DELTAS" &&
		closed(value, ["status", "basis", "direction", "runs", "totals"]) &&
		value.basis === "runtime-reported" &&
		value.direction === "b-minus-a" &&
		isDeltaRuns(value.runs, "tokens", isTokenDeltas) &&
		isTokenDeltas(value.totals)
	);
}

function isTiming(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "UNAVAILABLE")
		return (
			closed(value, ["status", "sides"]) &&
			isSides(value.sides) &&
			(value.sides.a !== null || value.sides.b !== null)
		);
	return (
		value.status === "DELTAS" &&
		closed(value, ["status", "basis", "clock", "direction", "runs", "totals"]) &&
		value.basis === "observer-measured" &&
		value.clock === "observer" &&
		value.direction === "b-minus-a" &&
		isDeltaRuns(value.runs, "wallMs", isQuantity) &&
		isRecord(value.totals) &&
		closed(value.totals, ["wallMs"]) &&
		isQuantity(value.totals.wallMs)
	);
}

function isFlagSide(value: unknown, facets: readonly string[]): boolean {
	return (
		isRecord(value) &&
		closed(value, facets) &&
		facets.every((facet) => {
			const items = value[facet];
			return Array.isArray(items) && items.every((item) => item === null || isText(item));
		})
	);
}

function isFlag(value: unknown): boolean {
	if (!isRecord(value) || !closed(value, ["kind", "a", "b"])) return false;
	if (!(ENDO_COCKPIT_COMPARISON_FLAG_KINDS_V0 as readonly unknown[]).includes(value.kind)) return false;
	const facets = value.kind === "configuration-differs" ? ["user", "project"] : ["values"];
	return isFlagSide(value.a, facets) && isFlagSide(value.b, facets);
}

const isSide = (value: unknown): boolean =>
	isRecord(value) &&
	closed(value, ["session", "eventsToken", "trajectoryToken"]) &&
	typeof value.session === "string" &&
	isEndoCockpitPublicIdV0(value.session, "session") &&
	isToken(value.eventsToken) &&
	isToken(value.trajectoryToken);

function isAgainstInputs(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!closed(value, ["firstDivergentResult", "firstDivergentCall", "callsIdenticalUpToFirstDivergentInput", "reason"])
	)
		return false;
	return (
		isPosition(value.firstDivergentResult) &&
		isPosition(value.firstDivergentCall) &&
		(value.callsIdenticalUpToFirstDivergentInput === null ||
			typeof value.callsIdenticalUpToFirstDivergentInput === "boolean") &&
		(ENDO_COCKPIT_COMPARISON_AGAINST_INPUTS_REASONS_V0 as readonly unknown[]).includes(value.reason)
	);
}

/**
 * Validate a serialized presentation record: its version and rules version exactly, a closed shape everywhere, free text only as
 * the text policy admits it, digests only as tokens or admitted keyed digests, and the verdict states consistent with
 * themselves. WIRE validation only: it cannot know the record matches any comparison (a token and a leaked plain sha256 have the
 * same shape; what the projection withholds is the projection's test, not a validator's).
 */
export function validateEndoCockpitTrajectoryComparisonV0(value: unknown): EndoCockpitTrajectoryComparisonV0 | null {
	if (!isRecord(value)) return null;
	if (
		!closed(value, [
			"schemaVersion",
			"projectionVersion",
			"keyId",
			"comparisonRules",
			"comparisonToken",
			"a",
			"b",
			"flags",
			"toolCallsAgainstInputs",
			"layers",
		])
	)
		return null;
	if (value.schemaVersion !== ENDO_COCKPIT_TRAJECTORY_COMPARISON_SCHEMA_V0) return null;
	if (value.projectionVersion !== ENDO_COCKPIT_TRAJECTORY_COMPARISON_PROJECTION_V0) return null;
	if (value.comparisonRules !== ENDO_TRAJECTORY_COMPARISON_RULES_V0.version) return null;
	if (!isEndoCockpitDigestKeyIdV0(value.keyId) || !isToken(value.comparisonToken)) return null;
	if (!isSide(value.a) || !isSide(value.b)) return null;
	if (!Array.isArray(value.flags) || !value.flags.every(isFlag)) return null;
	const kinds = (value.flags as R[]).map((flag) => flag.kind);
	if (new Set(kinds).size !== kinds.length) return null;
	if (!isAgainstInputs(value.toolCallsAgainstInputs)) return null;
	const layers = value.layers;
	if (!isRecord(layers) || !closed(layers, ["lifecycle", "toolCalls", "toolResults", "outcome", "usage", "timing"]))
		return null;
	if (
		!isVerdict(layers.lifecycle, isLifecycleEntry) ||
		!isVerdict(layers.toolCalls, isToolCallEntry) ||
		!isVerdict(layers.toolResults, isToolResultEntry) ||
		!isVerdict(layers.outcome, isOutcomeEntry) ||
		!isUsage(layers.usage) ||
		!isTiming(layers.timing)
	)
		return null;
	return value as unknown as EndoCockpitTrajectoryComparisonV0;
}
