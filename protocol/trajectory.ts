// Trajectories: what one recorded session did, reduced to layers that can be compared across sessions.
//
// `endo.trajectory.v0` is a projection of one recorded session (an adapter produces it read-only from its store;
// adapters/pi/trajectory.ts for Pi). It keeps five layers apart, by what they say and who said it:
//
// - lifecycle: the canonical `lifecycle.*` stream (protocol/session-lifecycle.ts), each event reduced to its kind and
//   the facts that describe the run rather than the recording (no ids, instances, timestamps or paths).
// - tools: the tool calls in the order they started, as (name, keyed digest of the canonical JSON of the arguments,
//   result status). Never argument or result text.
// - outcome: one entry per run: completed / failed / aborted / interrupted / unclassified / open, with a failure cause
//   by reference (sha256, length, classification), never its text.
// - usage: tokens per run, as the runtime reported them.
// - timing: wall time per run on the observer's own clock. The runtime reports no durations; this layer is what
//   Endophasia measured, kept apart from what the runtime reported.
//
// Every layer is either reported or UNAVAILABLE with a reason, and so is every field inside an entry the runtime or
// the recording does not carry. The record names its source (session, the digest of the events read) and the
// runtime environment it ran in (fingerprint, mapping, digest domain, configuration, model), so a comparison can flag
// mixed sources.
//
// `endo.trajectory-comparison.v0` is the result of comparing two trajectories (runtime/contracts/trajectory.ts). Its
// rules are ENDO_TRAJECTORY_COMPARISON_RULES_V0 below, and are part of the record.
//
// Identity: both records carry `digest`, the sha256 of the record's canonical JSON with `digest` and `provenance` left
// out. `provenance` says where the inputs were read (store paths). It is not part of the identity, so the same
// sessions give the same digest wherever their stores sit.

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

/** A keyed digest (runtime/contracts/keyed-digest.ts): comparable only with digests under the same key id. */
export interface EndoTrajectoryKeyedDigestV0 {
	algorithm: "hmac-sha256";
	keyId: string;
	value: string;
}

/** One tool call, in start order. `run` and `turn` are the observer's 1-based counts, null outside a run or turn. */
export interface EndoTrajectoryToolEntryV0 {
	run: number | null;
	turn: number | null;
	name: EndoReportedV0<string>;
	/** HMAC-SHA256 of the canonical JSON of the call's arguments, under the recording's digest domain. */
	argsDigest: EndoReportedV0<EndoTrajectoryKeyedDigestV0>;
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

/** What the runtime reported about one run's usage. */
export interface EndoTrajectoryUsageEntryV0 {
	run: number;
	assistantMessages: number;
	/** Assistant messages that carried no usage. */
	withoutUsage: number;
	tokens: EndoReportedV0<EndoTrajectoryTokensV0>;
}

/** What the observer measured about one run, on its own clock. */
export interface EndoTrajectoryTimingEntryV0 {
	run: number;
	clock: "observer";
	/** Milliseconds from the run's start to its end, as the observer recorded them. */
	wallMs: EndoReportedV0<number>;
}

/** One attachment of the runtime to the session, as recorded. */
export interface EndoTrajectoryAttachmentV0 {
	identityDigest: EndoReportedV0<string>;
	version: EndoReportedV0<string>;
	mapping: EndoReportedV0<string>;
	/** The digest domain the attachment's keyed digests were made in: the key's id and label, never the key. */
	digestKey: EndoReportedV0<{ keyId: string; domain: string }>;
	userConfigurationDigest: EndoReportedV0<string>;
	projectConfigurationDigest: EndoReportedV0<string>;
	/** `provider/model` as the attachment configured it. */
	configuredModel: EndoReportedV0<string>;
}

export interface EndoTrajectoryV0 {
	schemaVersion: "endo.trajectory.v0";
	/** The projector and its version, e.g. `pi-trajectory.1`. */
	projection: string;
	/** The content the trajectory was projected from. Location-free: see `provenance`. */
	source: {
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
		timing: EndoTrajectoryLayerV0<EndoTrajectoryTimingEntryV0>;
	};
	/** Where the source was read. Not digested. */
	provenance: { store: string };
	digest: string;
}

/** The rules a comparison applies. Part of every comparison record, so a rule change is a visible version change. */
export const ENDO_TRAJECTORY_COMPARISON_RULES_V0 = Object.freeze({
	version: "trajectory-comparison.1",
	alignment:
		"entries are aligned by their position within each layer, never by timestamp; the first position where the two sides differ is the divergence",
	equality:
		"two entries are equal when their canonical JSON is equal; tool argument digests are compared only within one digest domain (the same key id): a digest made under another key id, or one the recording did not capture, makes the entry unverifiable, never equal and never diverged",
	verdicts:
		"EXACT: both sides reported the layer, same length, every entry equal. DIVERGED: the first differing position, both entries (null past a side's end) and the common-prefix length. UNAVAILABLE: a side did not report the layer, or no entry differs but some could not be verified (each with its reason)",
	usage: "usage is never judged EXACT or DIVERGED: it reports per-run and total token deltas (b minus a) only; judging equality needs a noise band, which this version does not define",
	timing: "timing is the observer's clock, never the runtime's; like usage it reports deltas only and is never judged",
	environment:
		"different runtime fingerprints, versions, mappings, digest domains, configurations or models are allowed and listed in `flags`; they never change a verdict and are never silently mixed",
	symmetry:
		"compare(b, a) is compare(a, b) with the sides swapped and usage and timing deltas negated; compare(a, a) is EXACT on every layer a reports",
	identity:
		"the digest covers content identities (session and the sha256 of its events, per side) and the result; store paths are provenance and are not digested",
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
			/** When both sides reported it: the positions that could not be verified, and why. */
			unverified: { index: number; reason: string }[];
			lengths: { a: number; b: number } | null;
	  };

export type EndoTrajectoryTokenDeltaV0 = { [field: string]: number | null };

export interface EndoTrajectoryUsageRunDeltaV0 {
	run: number;
	/** Whether each side has this run. */
	present: { a: boolean; b: boolean };
	/** b minus a, per field; null for a field either side does not report; null when either side has no tokens. */
	tokens: EndoTrajectoryTokenDeltaV0 | null;
}

export type EndoTrajectoryUsageComparisonV0 =
	| { status: "DELTAS"; runs: EndoTrajectoryUsageRunDeltaV0[]; totals: { tokens: EndoTrajectoryTokenDeltaV0 } }
	| { status: "UNAVAILABLE"; a: string | null; b: string | null };

export interface EndoTrajectoryTimingRunDeltaV0 {
	run: number;
	present: { a: boolean; b: boolean };
	/** b minus a, observer clock; null when either side has no wall time for the run. */
	wallMs: number | null;
}

export type EndoTrajectoryTimingComparisonV0 =
	| { status: "DELTAS"; clock: "observer"; runs: EndoTrajectoryTimingRunDeltaV0[]; totals: { wallMs: number | null } }
	| { status: "UNAVAILABLE"; a: string | null; b: string | null };

export type EndoTrajectoryFlagKindV0 =
	| "runtime-fingerprint-differs"
	| "runtime-version-differs"
	| "mapping-differs"
	| "digest-domain-differs"
	| "configuration-differs"
	| "configured-model-differs"
	| "reported-model-differs"
	| "projection-differs";

export interface EndoTrajectoryFlagV0 {
	kind: EndoTrajectoryFlagKindV0;
	a: JsonValueV0;
	b: JsonValueV0;
}

/** One side's content identity: digested. */
export interface EndoTrajectoryComparisonSideV0 {
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
		timing: EndoTrajectoryTimingComparisonV0;
	};
	/** Where each side was read. Not digested. */
	provenance: { a: { store: string }; b: { store: string } };
	digest: string;
}

// --- validation -------------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^endo\.digest-key\.[0-9a-f]{32}$/;

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
const isPosition = (value: unknown): boolean => value !== null && isPositionOrNull(value);
const isFiniteNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const isNumberOrNull = (value: unknown): boolean => value === null || isFiniteNumber(value);
const isReasonOrNull = (value: unknown): boolean => value === null || typeof value === "string";
const isKeyedDigest = (value: unknown): boolean =>
	isRecord(value) &&
	keys(value, ["algorithm", "keyId", "value"]) &&
	value.algorithm === "hmac-sha256" &&
	typeof value.keyId === "string" &&
	KEY_ID.test(value.keyId) &&
	isSha(value.value);
const isDigestKey = (value: unknown): boolean =>
	isRecord(value) &&
	keys(value, ["keyId", "domain"]) &&
	typeof value.keyId === "string" &&
	KEY_ID.test(value.keyId) &&
	typeof value.domain === "string";

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
		keys(value, ["run", "turn", "name", "argsDigest", "result"]) &&
		isPositionOrNull(value.run) &&
		isPositionOrNull(value.turn) &&
		isReported(value.name, isString) &&
		isReported(value.argsDigest, isKeyedDigest) &&
		isReported(value.result, (item) => item === "ok" || item === "error")
	);
}

const OUTCOMES: readonly string[] = ["completed", "failed", "aborted", "interrupted", "unclassified", "open"];

function isOutcomeEntry(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, ["run", "outcome", "turns", "stopReason", "stopRequested", "cause"]) &&
		isPosition(value.run) &&
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
		keys(value, ["run", "assistantMessages", "withoutUsage", "tokens"]) &&
		isPosition(value.run) &&
		isCount(value.assistantMessages) &&
		isCount(value.withoutUsage) &&
		isReported(value.tokens, isTokens)
	);
}

function isTimingEntry(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, ["run", "clock", "wallMs"]) &&
		isPosition(value.run) &&
		value.clock === "observer" &&
		isReported(value.wallMs, isFiniteNumber)
	);
}

function isAttachment(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!keys(value, [
			"identityDigest",
			"version",
			"mapping",
			"digestKey",
			"userConfigurationDigest",
			"projectConfigurationDigest",
			"configuredModel",
		])
	)
		return false;
	const { digestKey, ...rest } = value;
	return isReported(digestKey, isDigestKey) && Object.values(rest).every((field) => isReported(field, isString));
}

/** The sha256 of a record's canonical JSON with `digest` and `provenance` left out. */
export type EndoRecordDigestV0 = (record: Record<string, unknown>) => string;

/**
 * Validate a trajectory: strict keys, every layer and entry shaped as above, and `digest` equal to `digestOf(record)`.
 * The digest function is injected so the protocol layer stays free of a hashing dependency. Returns the value or null.
 */
export function validateEndoTrajectoryV0(value: unknown, digestOf: EndoRecordDigestV0): EndoTrajectoryV0 | null {
	if (!isRecord(value)) return null;
	if (!keys(value, ["schemaVersion", "projection", "source", "environment", "layers", "provenance", "digest"]))
		return null;
	if (value.schemaVersion !== ENDO_TRAJECTORY_SCHEMA_V0 || typeof value.projection !== "string") return null;
	const source = value.source;
	if (
		!isRecord(source) ||
		!keys(source, [
			"session",
			"runtime",
			"runtimeSessionId",
			"attachment",
			"eventCount",
			"duplicatesIgnored",
			"eventsSha256",
		]) ||
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
		!keys(layers, ["lifecycle", "tools", "outcome", "usage", "timing"]) ||
		!isLayer(layers.lifecycle, isLifecycleEntry) ||
		!isLayer(layers.tools, isToolEntry) ||
		!isLayer(layers.outcome, isOutcomeEntry) ||
		!isLayer(layers.usage, isUsageEntry) ||
		!isLayer(layers.timing, isTimingEntry)
	)
		return null;
	const provenance = value.provenance;
	if (!isRecord(provenance) || !keys(provenance, ["store"]) || typeof provenance.store !== "string") return null;
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
				isReasonOrNull(value.a) &&
				isReasonOrNull(value.b) &&
				Array.isArray(value.unverified) &&
				value.unverified.every(
					(item) =>
						isRecord(item) &&
						keys(item, ["index", "reason"]) &&
						isCount(item.index) &&
						typeof item.reason === "string",
				) &&
				(value.lengths === null || lengths(value.lengths))
			);
		default:
			return false;
	}
}

const isTokenDelta = (value: unknown): boolean => isRecord(value) && Object.values(value).every(isNumberOrNull);
const isPresence = (value: unknown): boolean =>
	isRecord(value) && keys(value, ["a", "b"]) && typeof value.a === "boolean" && typeof value.b === "boolean";
const isUnavailablePair = (value: Record<string, unknown>): boolean =>
	keys(value, ["status", "a", "b"]) && isReasonOrNull(value.a) && isReasonOrNull(value.b);

function isUsageComparison(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "UNAVAILABLE") return isUnavailablePair(value);
	if (value.status !== "DELTAS" || !keys(value, ["status", "runs", "totals"])) return false;
	const totals = value.totals;
	return (
		Array.isArray(value.runs) &&
		value.runs.every(
			(run) =>
				isRecord(run) &&
				keys(run, ["run", "present", "tokens"]) &&
				isPosition(run.run) &&
				isPresence(run.present) &&
				(run.tokens === null || isTokenDelta(run.tokens)),
		) &&
		isRecord(totals) &&
		keys(totals, ["tokens"]) &&
		isTokenDelta(totals.tokens)
	);
}

function isTimingComparison(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "UNAVAILABLE") return isUnavailablePair(value);
	if (value.status !== "DELTAS" || !keys(value, ["status", "clock", "runs", "totals"]) || value.clock !== "observer")
		return false;
	const totals = value.totals;
	return (
		Array.isArray(value.runs) &&
		value.runs.every(
			(run) =>
				isRecord(run) &&
				keys(run, ["run", "present", "wallMs"]) &&
				isPosition(run.run) &&
				isPresence(run.present) &&
				isNumberOrNull(run.wallMs),
		) &&
		isRecord(totals) &&
		keys(totals, ["wallMs"]) &&
		isNumberOrNull(totals.wallMs)
	);
}

const FLAG_KINDS: readonly string[] = [
	"runtime-fingerprint-differs",
	"runtime-version-differs",
	"mapping-differs",
	"digest-domain-differs",
	"configuration-differs",
	"configured-model-differs",
	"reported-model-differs",
	"projection-differs",
];

function isSide(value: unknown): boolean {
	return (
		isRecord(value) &&
		keys(value, ["session", "eventsSha256", "trajectoryDigest"]) &&
		typeof value.session === "string" &&
		isSha(value.eventsSha256) &&
		isSha(value.trajectoryDigest)
	);
}

const isStoreProvenance = (value: unknown): boolean =>
	isRecord(value) && keys(value, ["store"]) && typeof value.store === "string";

/** Validate a comparison record, including its rules (the current version's, exactly) and its digest. */
export function validateEndoTrajectoryComparisonV0(
	value: unknown,
	digestOf: EndoRecordDigestV0,
): EndoTrajectoryComparisonV0 | null {
	if (!isRecord(value)) return null;
	if (!keys(value, ["schemaVersion", "rules", "a", "b", "flags", "layers", "provenance", "digest"])) return null;
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
		!keys(layers, ["lifecycle", "tools", "outcome", "usage", "timing"]) ||
		!isVerdict(layers.lifecycle) ||
		!isVerdict(layers.tools) ||
		!isVerdict(layers.outcome) ||
		!isUsageComparison(layers.usage) ||
		!isTimingComparison(layers.timing)
	)
		return null;
	const provenance = value.provenance;
	if (
		!isRecord(provenance) ||
		!keys(provenance, ["a", "b"]) ||
		!isStoreProvenance(provenance.a) ||
		!isStoreProvenance(provenance.b)
	)
		return null;
	if (!isSha(value.digest) || digestOf(value) !== value.digest) return null;
	return value as unknown as EndoTrajectoryComparisonV0;
}
