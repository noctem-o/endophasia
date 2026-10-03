// Trajectories: what one recorded session did, reduced to layers that can be compared across sessions.
//
// `endo.trajectory.v0` is a projection of one recorded session (an adapter produces it read-only from its store;
// adapters/pi/trajectory.ts for Pi). It keeps four layers apart:
//
// - lifecycle: the canonical `lifecycle.*` stream (protocol/session-lifecycle.ts), each event reduced to its kind and
//   the facts that describe the run rather than the recording (no ids, instances, timestamps or paths).
// - tools: the tool calls in the order they started, as (name, sha256 of the canonical JSON of the arguments, result
//   status). Never argument or result text.
// - outcome: one entry per run: completed / failed / aborted / interrupted / unclassified / open, with a failure cause
//   by reference (sha256, length, classification), never its text.
// - usage: tokens per run as the runtime reported them, and wall time per run as the observer measured it.
//
// Every layer is either reported or UNAVAILABLE with a reason, and so is every field inside an entry the runtime or
// the recording does not carry. The record names its source (store, session, the digest of the events read) and the
// runtime environment it ran in (fingerprint, mapping, configuration, model), so a comparison can flag mixed sources.
//
// `endo.trajectory-comparison.v0` is the result of comparing two trajectories (runtime/contracts/trajectory.ts). Its
// rules are ENDO_TRAJECTORY_COMPARISON_RULES_V0 below, and are part of the record.
//
// Both records carry `digest`: the sha256 of the record's canonical JSON with `digest` left out.

import type { JsonValueV0 } from "./primitives.ts";
import type { EndoReportedV0 } from "./session-lifecycle.ts";

export const ENDO_TRAJECTORY_SCHEMA_V0 = "endo.trajectory.v0";
export const ENDO_TRAJECTORY_COMPARISON_SCHEMA_V0 = "endo.trajectory-comparison.v0";

/** A layer the recording carries, or the reason it does not. */
export type EndoTrajectoryLayerV0<T> = { status: "reported"; entries: T[] } | { status: "UNAVAILABLE"; reason: string };

/** One lifecycle event, reduced: its kind and the facts that describe the run. `recognized` is false for a kind the
 * trajectory version does not define; its payload is then kept only by digest. */
export interface EndoTrajectoryLifecycleEntryV0 {
	kind: string;
	recognized: boolean;
	facts: { [key: string]: JsonValueV0 };
}

/** One tool call, in start order. `run` and `turn` are the observer's 1-based counts, null outside a run or turn. */
export interface EndoTrajectoryToolEntryV0 {
	run: number | null;
	turn: number | null;
	name: EndoReportedV0<string>;
	/** sha256 of the canonical JSON of the call's arguments. */
	argsSha256: EndoReportedV0<string>;
	/** "ok" or "error" as the runtime reported it; UNAVAILABLE when no end was recorded. */
	result: EndoReportedV0<"ok" | "error">;
}

export type EndoTrajectoryOutcomeKindV0 = "completed" | "failed" | "aborted" | "interrupted" | "unclassified" | "open";

/** How one run ended. `cause`: the runtime's cause for `failed` (by reference), the interruption for `interrupted`. */
export interface EndoTrajectoryOutcomeEntryV0 {
	run: number;
	outcome: EndoTrajectoryOutcomeKindV0;
	turns: number;
	stopReason: EndoReportedV0<string>;
	stopRequested: boolean;
	cause: JsonValueV0;
}

/** Token counts summed over a run's assistant messages. `reasoning` and `costTotal` only when every message had them. */
export interface EndoTrajectoryTokensV0 {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoning?: number;
	costTotal?: number;
}

export interface EndoTrajectoryUsageEntryV0 {
	run: number;
	assistantMessages: number;
	/** Assistant messages that carried no usage. */
	withoutUsage: number;
	tokens: EndoReportedV0<EndoTrajectoryTokensV0>;
	/** Milliseconds from run start to run end on the observer's clock (the runtime reports no duration). */
	wallMs: EndoReportedV0<number>;
}

/** One attachment of the runtime to the session, as recorded. */
export interface EndoTrajectoryAttachmentV0 {
	identityDigest: EndoReportedV0<string>;
	version: EndoReportedV0<string>;
	mapping: EndoReportedV0<string>;
	userConfigurationDigest: EndoReportedV0<string>;
	projectConfigurationDigest: EndoReportedV0<string>;
	/** `provider/model` as the attachment configured it. */
	configuredModel: EndoReportedV0<string>;
}

export interface EndoTrajectoryV0 {
	schemaVersion: "endo.trajectory.v0";
	/** The projector and its version, e.g. `pi-trajectory.1`. */
	projection: string;
	source: {
		/** The store as the caller named it. */
		store: string;
		/** The endo session coordinate. */
		session: string;
		runtime: string;
		runtimeSessionId: EndoReportedV0<string>;
		attachment: string;
		/** The session's events read from the store, after deduplication by id. */
		eventCount: number;
		duplicatesIgnored: number;
		/** sha256 of the canonical JSON of those events, in store order. */
		eventsSha256: string;
	};
	environment: {
		attachments: EndoTrajectoryAttachmentV0[];
		/** `provider/model` pairs the runtime reported on its assistant messages, sorted. */
		reportedModels: string[];
	};
	layers: {
		lifecycle: EndoTrajectoryLayerV0<EndoTrajectoryLifecycleEntryV0>;
		tools: EndoTrajectoryLayerV0<EndoTrajectoryToolEntryV0>;
		outcome: EndoTrajectoryLayerV0<EndoTrajectoryOutcomeEntryV0>;
		usage: EndoTrajectoryLayerV0<EndoTrajectoryUsageEntryV0>;
	};
	digest: string;
}

/** The rules a comparison applies. Part of every comparison record, so a rule change is a visible version change. */
export const ENDO_TRAJECTORY_COMPARISON_RULES_V0 = Object.freeze({
	version: "trajectory-comparison.1",
	alignment:
		"entries are aligned by their position within each layer, never by timestamp; the first position where the two sides differ is the divergence",
	equality:
		"two entries are equal when their canonical JSON is equal; a field UNAVAILABLE because the recording did not capture it (tool argsSha256) makes the entry unverifiable, not equal",
	verdicts:
		"EXACT: both sides reported the layer, same length, every entry equal. DIVERGED: the first differing position, both entries (null past a side's end) and the common-prefix length. UNAVAILABLE: a side did not report the layer, or no entry differs but some could not be verified",
	usage: "usage is never judged EXACT or DIVERGED: it reports per-run and total deltas (b minus a) only; judging equality needs a noise band, which this version does not define",
	environment:
		"different runtime fingerprints, versions, mappings, configurations or models are allowed and listed in `flags`; they never change a verdict and are never silently mixed",
	symmetry:
		"compare(b, a) is compare(a, b) with the sides swapped and usage deltas negated; compare(a, a) is EXACT on every layer a reports",
});

export type EndoTrajectoryComparisonRulesV0 = typeof ENDO_TRAJECTORY_COMPARISON_RULES_V0;

export type EndoTrajectoryVerdictV0 =
	| { status: "EXACT"; length: number }
	| {
			status: "DIVERGED";
			index: number;
			commonPrefix: number;
			lengths: { a: number; b: number };
			a: JsonValueV0;
			b: JsonValueV0;
	  }
	| {
			status: "UNAVAILABLE";
			/** Why each side is unavailable (null when that side reported the layer). */
			a: string | null;
			b: string | null;
			/** When both sides reported it: the positions that could not be verified. */
			unverified: number[];
			lengths: { a: number; b: number } | null;
	  };

export type EndoTrajectoryTokenDeltaV0 = { [field: string]: number | null };

export interface EndoTrajectoryUsageRunDeltaV0 {
	run: number;
	/** b minus a, per field; null when either side does not report the field. Absent sides are `present: false`. */
	present: { a: boolean; b: boolean };
	tokens: EndoTrajectoryTokenDeltaV0 | null;
	wallMs: number | null;
}

export type EndoTrajectoryUsageComparisonV0 =
	| {
			status: "DELTAS";
			runs: EndoTrajectoryUsageRunDeltaV0[];
			totals: { tokens: EndoTrajectoryTokenDeltaV0; wallMs: number | null };
	  }
	| { status: "UNAVAILABLE"; a: string | null; b: string | null };

export type EndoTrajectoryFlagKindV0 =
	| "runtime-fingerprint-differs"
	| "runtime-version-differs"
	| "mapping-differs"
	| "configuration-differs"
	| "configured-model-differs"
	| "reported-model-differs"
	| "projection-differs";

export interface EndoTrajectoryFlagV0 {
	kind: EndoTrajectoryFlagKindV0;
	a: JsonValueV0;
	b: JsonValueV0;
}

export interface EndoTrajectoryComparisonSideV0 {
	store: string;
	session: string;
	eventsSha256: string;
	trajectoryDigest: string;
}

export interface EndoTrajectoryComparisonV0 {
	schemaVersion: "endo.trajectory-comparison.v0";
	rules: EndoTrajectoryComparisonRulesV0;
	a: EndoTrajectoryComparisonSideV0;
	b: EndoTrajectoryComparisonSideV0;
	flags: EndoTrajectoryFlagV0[];
	layers: {
		lifecycle: EndoTrajectoryVerdictV0;
		tools: EndoTrajectoryVerdictV0;
		outcome: EndoTrajectoryVerdictV0;
		usage: EndoTrajectoryUsageComparisonV0;
	};
	digest: string;
}

// --- validation -------------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SHA256 = /^[0-9a-f]{64}$/;

function keys(value: Record<string, unknown>, allowed: readonly string[], required = allowed): boolean {
	return (
		Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key))
	);
}

function isReported(value: unknown, inner: (item: unknown) => boolean): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "reported") return keys(value, ["status", "value"]) && inner(value.value);
	if (value.status === "UNAVAILABLE") return keys(value, ["status", "reason"]) && typeof value.reason === "string";
	return false;
}

const isString = (value: unknown): boolean => typeof value === "string";
const isSha = (value: unknown): boolean => typeof value === "string" && SHA256.test(value);
const isCount = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositionOrNull = (value: unknown): boolean =>
	value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1);
const isFiniteNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const isNumberOrNull = (value: unknown): boolean => value === null || isFiniteNumber(value);

function isLayer(value: unknown, entry: (item: unknown) => boolean): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "reported")
		return keys(value, ["status", "entries"]) && Array.isArray(value.entries) && value.entries.every(entry);
	if (value.status === "UNAVAILABLE") return keys(value, ["status", "reason"]) && typeof value.reason === "string";
	return false;
}

function isLifecycleEntry(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, ["kind", "recognized", "facts"]) &&
		typeof value.kind === "string" &&
		value.kind.startsWith("lifecycle.") &&
		typeof value.recognized === "boolean" &&
		isRecord(value.facts)
	);
}

function isToolEntry(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, ["run", "turn", "name", "argsSha256", "result"]) &&
		isPositionOrNull(value.run) &&
		isPositionOrNull(value.turn) &&
		isReported(value.name, isString) &&
		isReported(value.argsSha256, isSha) &&
		isReported(value.result, (item) => item === "ok" || item === "error")
	);
}

const OUTCOMES: readonly string[] = ["completed", "failed", "aborted", "interrupted", "unclassified", "open"];

function isOutcomeEntry(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, ["run", "outcome", "turns", "stopReason", "stopRequested", "cause"]) &&
		isPositionOrNull(value.run) &&
		value.run !== null &&
		typeof value.outcome === "string" &&
		OUTCOMES.includes(value.outcome) &&
		isCount(value.turns) &&
		isReported(value.stopReason, isString) &&
		typeof value.stopRequested === "boolean" &&
		value.cause !== undefined
	);
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const OPTIONAL_TOKEN_FIELDS = ["reasoning", "costTotal"] as const;

function isTokens(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, [...TOKEN_FIELDS, ...OPTIONAL_TOKEN_FIELDS], TOKEN_FIELDS) &&
		Object.values(value).every(isFiniteNumber)
	);
}

function isUsageEntry(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, ["run", "assistantMessages", "withoutUsage", "tokens", "wallMs"]) &&
		isPositionOrNull(value.run) &&
		value.run !== null &&
		isCount(value.assistantMessages) &&
		isCount(value.withoutUsage) &&
		isReported(value.tokens, isTokens) &&
		isReported(value.wallMs, isFiniteNumber)
	);
}

function isAttachment(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, [
			"identityDigest",
			"version",
			"mapping",
			"userConfigurationDigest",
			"projectConfigurationDigest",
			"configuredModel",
		]) &&
		Object.values(value).every((field) => isReported(field, isString))
	);
}

/** The sha256 of a record's canonical JSON with `digest` left out. */
export type EndoRecordDigestV0 = (record: Record<string, unknown>) => string;

/**
 * Validate a trajectory: strict keys, every layer and entry shaped as above, and `digest` equal to `digestOf(record)`.
 * The digest function is injected so the protocol layer stays free of a hashing dependency. Returns the value or null.
 */
export function validateEndoTrajectoryV0(value: unknown, digestOf: EndoRecordDigestV0): EndoTrajectoryV0 | null {
	if (!isRecord(value)) return null;
	if (!keys(value, ["schemaVersion", "projection", "source", "environment", "layers", "digest"])) return null;
	if (value.schemaVersion !== ENDO_TRAJECTORY_SCHEMA_V0 || typeof value.projection !== "string") return null;
	const source = value.source;
	if (
		!isRecord(source) ||
		!keys(source, [
			"store",
			"session",
			"runtime",
			"runtimeSessionId",
			"attachment",
			"eventCount",
			"duplicatesIgnored",
			"eventsSha256",
		]) ||
		typeof source.store !== "string" ||
		typeof source.session !== "string" ||
		typeof source.runtime !== "string" ||
		!isReported(source.runtimeSessionId, isString) ||
		typeof source.attachment !== "string" ||
		!isCount(source.eventCount) ||
		!isCount(source.duplicatesIgnored) ||
		!isSha(source.eventsSha256)
	)
		return null;
	const environment = value.environment;
	if (
		!isRecord(environment) ||
		!keys(environment, ["attachments", "reportedModels"]) ||
		!Array.isArray(environment.attachments) ||
		!environment.attachments.every(isAttachment) ||
		!Array.isArray(environment.reportedModels) ||
		!environment.reportedModels.every(isString)
	)
		return null;
	const layers = value.layers;
	if (
		!isRecord(layers) ||
		!keys(layers, ["lifecycle", "tools", "outcome", "usage"]) ||
		!isLayer(layers.lifecycle, isLifecycleEntry) ||
		!isLayer(layers.tools, isToolEntry) ||
		!isLayer(layers.outcome, isOutcomeEntry) ||
		!isLayer(layers.usage, isUsageEntry)
	)
		return null;
	if (!isSha(value.digest) || digestOf(value) !== value.digest) return null;
	return value as unknown as EndoTrajectoryV0;
}

function isVerdict(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const lengths = (item: unknown): boolean =>
		isRecord(item) && keys(item, ["a", "b"]) && isCount(item.a) && isCount(item.b);
	switch (value.status) {
		case "EXACT":
			return keys(value, ["status", "length"]) && isCount(value.length);
		case "DIVERGED":
			return (
				keys(value, ["status", "index", "commonPrefix", "lengths", "a", "b"]) &&
				isCount(value.index) &&
				value.commonPrefix === value.index &&
				lengths(value.lengths) &&
				value.a !== undefined &&
				value.b !== undefined
			);
		case "UNAVAILABLE":
			return (
				keys(value, ["status", "a", "b", "unverified", "lengths"]) &&
				(value.a === null || typeof value.a === "string") &&
				(value.b === null || typeof value.b === "string") &&
				Array.isArray(value.unverified) &&
				value.unverified.every(isCount) &&
				(value.lengths === null || lengths(value.lengths))
			);
		default:
			return false;
	}
}

function isTokenDelta(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every(isNumberOrNull);
}

function isUsageComparison(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "UNAVAILABLE")
		return (
			keys(value, ["status", "a", "b"]) &&
			(value.a === null || typeof value.a === "string") &&
			(value.b === null || typeof value.b === "string")
		);
	if (value.status !== "DELTAS" || !keys(value, ["status", "runs", "totals"])) return false;
	const totals = value.totals;
	return (
		Array.isArray(value.runs) &&
		value.runs.every(
			(run) =>
				isRecord(run) &&
				keys(run, ["run", "present", "tokens", "wallMs"]) &&
				isPositionOrNull(run.run) &&
				isRecord(run.present) &&
				keys(run.present, ["a", "b"]) &&
				(run.tokens === null || isTokenDelta(run.tokens)) &&
				isNumberOrNull(run.wallMs),
		) &&
		isRecord(totals) &&
		keys(totals, ["tokens", "wallMs"]) &&
		isTokenDelta(totals.tokens) &&
		isNumberOrNull(totals.wallMs)
	);
}

const FLAG_KINDS: readonly string[] = [
	"runtime-fingerprint-differs",
	"runtime-version-differs",
	"mapping-differs",
	"configuration-differs",
	"configured-model-differs",
	"reported-model-differs",
	"projection-differs",
];

function isSide(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, ["store", "session", "eventsSha256", "trajectoryDigest"]) &&
		typeof value.store === "string" &&
		typeof value.session === "string" &&
		isSha(value.eventsSha256) &&
		isSha(value.trajectoryDigest)
	);
}

/** Validate a comparison record, including its rules (the current version's, exactly) and its digest. */
export function validateEndoTrajectoryComparisonV0(
	value: unknown,
	digestOf: EndoRecordDigestV0,
): EndoTrajectoryComparisonV0 | null {
	if (!isRecord(value)) return null;
	if (!keys(value, ["schemaVersion", "rules", "a", "b", "flags", "layers", "digest"])) return null;
	if (value.schemaVersion !== ENDO_TRAJECTORY_COMPARISON_SCHEMA_V0) return null;
	const rules = value.rules;
	if (
		!isRecord(rules) ||
		!keys(rules, Object.keys(ENDO_TRAJECTORY_COMPARISON_RULES_V0)) ||
		Object.entries(ENDO_TRAJECTORY_COMPARISON_RULES_V0).some(([key, text]) => rules[key] !== text)
	)
		return null;
	if (!isSide(value.a) || !isSide(value.b)) return null;
	if (
		!Array.isArray(value.flags) ||
		!value.flags.every(
			(flag) =>
				isRecord(flag) &&
				keys(flag, ["kind", "a", "b"]) &&
				typeof flag.kind === "string" &&
				FLAG_KINDS.includes(flag.kind),
		)
	)
		return null;
	const layers = value.layers;
	if (
		!isRecord(layers) ||
		!keys(layers, ["lifecycle", "tools", "outcome", "usage"]) ||
		!isVerdict(layers.lifecycle) ||
		!isVerdict(layers.tools) ||
		!isVerdict(layers.outcome) ||
		!isUsageComparison(layers.usage)
	)
		return null;
	if (!isSha(value.digest) || digestOf(value) !== value.digest) return null;
	return value as unknown as EndoTrajectoryComparisonV0;
}
