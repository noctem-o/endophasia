// The cockpit read-model v0 schemas: the versioned, harness-neutral presentation data a future local cockpit consumes.
//
// These are PROJECTIONS, not evidence. They are computed from Endophasia's durable records (the event log and the harness
// registry), never stored back, and never an authority: nothing here grants, infers or exercises a capability, and a
// consumer that reloads them from the store must get the same view. They are therefore not in the durable schema
// catalogue (docs/schema-compatibility.md); they do follow its rule for the records they are read from: an unknown
// version is rejected, never partially interpreted, and a closed record rejects unknown fields.
//
// Four top-level records, deliberately separate because their sources have independent histories:
// - endo.cockpit-runtime-identity.v0: one attachment's recorded runtime identity, last change and last notice.
// - endo.cockpit-capability-state.v0: the recorded capability state of that attachment, with its evidence dependencies.
// - endo.cockpit-session-timeline.v0: a bounded window of the durable event log in storage order.
// - endo.cockpit-snapshot.v0: the three above read together, WITHOUT any claim of a shared snapshot boundary.
//
// Every top-level record names its source (`domain`, how the source was found, and a watermark), and its projection
// definition version (`projectionVersion`): the same validated inputs under the same projection version give the same
// canonical output. Nothing here carries a wall-clock read, a random id, or the store's location.
//
// Epistemic bases are kept apart, never merged into a score:
// - observed: collected by Endophasia itself from the local installation or process;
// - reported: stated by the runtime about itself;
// - derived: computed by Endophasia from other recorded facts (including derivations the record itself declares);
// - inferred: reserved. No v0 projection produces it, because no projection infers missing evidence;
// - unavailable: the record does not carry it (or it is held back by the presentation boundary), with a reason.
// An event's own source class (runtime-fact, interpretation, ...) is carried verbatim next to these; it is not mapped
// into them.
//
// Presentation boundary: the projections copy an allowlist of fields. Anything else in a source record (paths,
// arguments, error text, notice lines, unknown payload fields) is counted or named as withheld, never copied. Where a
// record exists without an approved presentation body, its reference and availability are exposed instead.
//
// Two guarantees, kept apart. WIRE validation (the validators below) proves a serialized record is well formed and
// consistent with itself: references name the right domain, attachment, record kind and id for the view that holds them,
// lie inside the source's watermark, and the pagination metadata agrees with the watermark. STORE verification (that the
// referenced record exists on disk and says what the view says) needs the store and is NOT performed by any validator
// here; a consumer that needs it re-reads the source (cockpit/reader.ts). A validator that accepts a record has not
// looked at the disk.
//
// The protocol imports only the protocol.

import { ENDO_CONFORMANCE_CLASSIFICATIONS_V0, type EndoConformanceClassificationV0 } from "./evaluation.ts";
import { ENDO_EVENT_SOURCES_V0, type EndoEventSourceV0 } from "./event.ts";
import {
	ENDO_CAPABILITY_CHECK_KINDS_V0,
	ENDO_CAPABILITY_STATUSES_V0,
	ENDO_HARNESS_CHANGE_KINDS_V0,
	ENDO_HARNESS_DIFFERENCES_V0,
	ENDO_HARNESS_NOTIFICATION_KINDS_V0,
	ENDO_HARNESS_VERSION_ORDERS_V0,
	type EndoCapabilityCheckKindV0,
	type EndoCapabilityStatusV0,
	type EndoHarnessChangeKindV0,
	type EndoHarnessDifferenceV0,
	type EndoHarnessIdentityConfidenceV0,
	type EndoHarnessNotificationKindV0,
	type EndoHarnessVersionOrderV0,
} from "./harness.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import { isIso8601UtcV0, isPlainJsonObjectV0 } from "./primitives.ts";
import { defineEndoVersionTableV0, type EndoVersionedReadV0, readEndoVersionedV0 } from "./versioned.ts";

// ---------------------------------------------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------------------------------------------

/** The projection definition versions of this contract version. A change to what a projection computes bumps its own. */
export const ENDO_COCKPIT_PROJECTION_VERSIONS_V0 = {
	runtimeIdentity: "cockpit-runtime-identity.1",
	capabilityState: "cockpit-capability-state.1",
	sessionTimeline: "cockpit-session-timeline.1",
	snapshot: "cockpit-snapshot.1",
} as const;

/**
 * What stands in place of a recorded free-text value (a reason, a limitation, a title, a runtime-reported string) that
 * appears to embed a local path, a network address or a credential. A fixed text: it reveals nothing of the original and
 * is the same on every run. Heuristic and deliberately conservative (cockpit/projections/common.ts): it withholds, it
 * never rewrites, and a value it passes is bounded but not certified safe.
 */
export const ENDO_COCKPIT_WITHHELD_TEXT_V0 =
	"withheld: the recorded text appears to embed a local path, network address or credential";

/** The epistemic bases a presented claim may carry (plus "unavailable", a claim without a value). */
export const ENDO_COCKPIT_BASES_V0 = ["observed", "reported", "derived", "inferred"] as const;
export type EndoCockpitBasisV0 = (typeof ENDO_COCKPIT_BASES_V0)[number];

/** The harness-registry record kinds, in the fixed order used wherever the kinds are listed. */
export const ENDO_COCKPIT_REGISTRY_KINDS_V0 = ["fingerprint", "change", "evidence", "state", "notification"] as const;
export type EndoCockpitRegistryKindV0 = (typeof ENDO_COCKPIT_REGISTRY_KINDS_V0)[number];

/**
 * How a source was found.
 * - absent: nothing exists at the source's location (never created by reading).
 * - empty: the log exists and holds no frames.
 * - readable: every frame verified and validated.
 * - degraded: a prefix is readable, and the log ends in a torn tail or at a frame that failed verification. A torn
 *   tail may be an append in flight in a live writer; a read-only open never repairs it.
 * - unopenable: the source exists but could not be opened (invalid records, an unknown version, an unreadable path).
 *   Nothing is projected from it, and it is never reported as empty.
 */
export const ENDO_COCKPIT_SOURCE_STATES_V0 = ["absent", "empty", "readable", "degraded", "unopenable"] as const;
export type EndoCockpitSourceStateV0 = (typeof ENDO_COCKPIT_SOURCE_STATES_V0)[number];

export const ENDO_COCKPIT_NOTE_CODES_V0 = [
	"no-fingerprint-recorded",
	"latest-change-not-for-latest-fingerprint",
	"latest-change-is-collection-failure",
	"notification-change-missing",
	"runtime-disagreement",
	"foreign-attachment-record",
	"duplicate-record-id",
	"duplicate-capability",
	"state-without-fingerprint",
	"no-capability-state-recorded",
	"source-not-projectable",
] as const;
export type EndoCockpitNoteCodeV0 = (typeof ENDO_COCKPIT_NOTE_CODES_V0)[number];

export const ENDO_COCKPIT_LIMIT_CODES_V0 = [
	"state-not-for-latest-fingerprint",
	"state-without-fingerprint",
	"state-fingerprint-not-recorded",
	"evidence-record-missing",
	"evidence-capability-differs",
	"evidence-classification-differs",
	"evidence-identity-differs",
	"evidence-reduced-identity",
	"status-classification-mismatch",
	"runtime-differs",
	"evidence-check-insufficient",
] as const;
export type EndoCockpitLimitCodeV0 = (typeof ENDO_COCKPIT_LIMIT_CODES_V0)[number];

/** The event categories of a timeline entry, by the first dotted segment of the kind; "other" for any other segment. */
export const ENDO_COCKPIT_CATEGORIES_V0 = [
	"lifecycle",
	"agent",
	"message",
	"tool",
	"session",
	"queue",
	"compaction",
	"retry",
	"harness",
	"control",
	"other",
] as const;
export type EndoCockpitCategoryV0 = (typeof ENDO_COCKPIT_CATEGORIES_V0)[number];

export const ENDO_COCKPIT_FLAGS_V0 = ["interruption", "discontinuity", "anomaly", "unrecognized"] as const;
export type EndoCockpitFlagV0 = (typeof ENDO_COCKPIT_FLAGS_V0)[number];

// ---------------------------------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------------------------------

/** A stable reference to the record a presented value was read from. */
export type EndoCockpitRefV0 =
	| { domain: "event-log"; storageSequence: number; eventId: string }
	| {
			domain: "harness-registry";
			attachment: string;
			kind: EndoCockpitRegistryKindV0;
			/** The 0-based position among the records of this kind, in append order (the registry is append-only). */
			index: number;
			/** The record's own identifier, or null for a record kind that has none (capability state). */
			id: string | null;
	  };

/** A presented value with its basis and the records it comes from, or the reason there is no value. */
export type EndoCockpitClaimV0<T> =
	| { basis: EndoCockpitBasisV0; value: T; refs: EndoCockpitRefV0[] }
	| { basis: "unavailable"; reason: string; refs: EndoCockpitRefV0[] };

/** A scalar presented from one event's payload: the event is the provenance, so a field carries only its basis. */
export type EndoCockpitFieldV0 =
	| { basis: EndoCockpitBasisV0; value: string | number | boolean | null }
	| { basis: "unavailable"; reason: string };

export interface EndoCockpitNoteV0 {
	code: EndoCockpitNoteCodeV0;
	refs: EndoCockpitRefV0[];
}

/** The state of one source and what a read-only open found; `error` holds only a bounded, escaped message. */
export interface EndoCockpitSourceConditionV0 {
	state: EndoCockpitSourceStateV0;
	/** The torn tail left in place (length and sha256), or null. */
	tornTail: { bytes: number; sha256: string } | null;
	/** The 1-based index of the first frame that failed verification, or null. Writes to a sealed store are refused. */
	sealedAt: number | null;
	error: { kind: string; message: string } | null;
}

/**
 * The event log's position. `length` events were read, the last of them `lastEventId`; `prefixDigest` binds the complete
 * content of those events, in storage order: the sha256 over one line per event, each line the lowercase hex sha256 of
 * the event's canonical JSON (runtime/contracts/canonical-json.ts) followed by "\n". Every line has the same width and
 * alphabet, so the framing is unambiguous and any language can recompute it. The same digest over the first `length`
 * events of a later read proves the held prefix is still the prefix, even when an event was replaced under the same id.
 * A consumer continues from `afterSequence = its length` only after that check (cockpit/reader.ts,
 * checkEndoCockpitSourceFreshnessV0). Both are null for an empty log.
 */
export interface EndoCockpitEventLogWatermarkV0 {
	length: number;
	lastEventId: string | null;
	prefixDigest: string | null;
}

export interface EndoCockpitEventLogSourceV0 {
	domain: "event-log";
	condition: EndoCockpitSourceConditionV0;
	/** Null exactly when the log could not be opened. */
	watermark: EndoCockpitEventLogWatermarkV0 | null;
}

/**
 * One attachment's registry position. The registry has no cursor, so a change of any part means re-reading the
 * attachment's registry; `contentDigest` is the sha256 of the canonical JSON of its records, kind by kind, in append
 * order, so equal watermarks mean equal records.
 */
export interface EndoCockpitRegistryWatermarkV0 {
	counts: Record<EndoCockpitRegistryKindV0, number>;
	lastIds: Record<EndoCockpitRegistryKindV0, string | null>;
	contentDigest: string;
}

export interface EndoCockpitRegistrySourceV0 {
	domain: "harness-registry";
	attachment: string;
	condition: EndoCockpitSourceConditionV0;
	watermark: EndoCockpitRegistryWatermarkV0 | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Runtime identity
// ---------------------------------------------------------------------------------------------------------------

export interface EndoCockpitFingerprintViewV0 {
	ref: EndoCockpitRefV0;
	id: string;
	observedAt: string;
	identity: EndoCockpitClaimV0<{ digest: string; confidence: EndoHarnessIdentityConfidenceV0 }>;
	/** The version the runtime reported. */
	version: EndoCockpitClaimV0<string>;
	/** The sha256 and size of the entrypoint file, as observed locally. */
	entrypoint: EndoCockpitClaimV0<{ sha256: string; bytes: number }>;
	package: EndoCockpitClaimV0<{ name: string; version: string }>;
	/** The recorded fields that are not presented: local paths and the version command's raw output. */
	withheld: string[];
}

export interface EndoCockpitObservationViewV0 {
	fingerprintId: string;
	identityDigest: string;
	confidence: EndoHarnessIdentityConfidenceV0;
	/** The version the runtime reported at that observation, or null when it reported none. */
	version: string | null;
}

export interface EndoCockpitChangeViewV0 {
	ref: EndoCockpitRefV0;
	id: string;
	at: string;
	kind: EndoHarnessChangeKindV0;
	differences: EndoHarnessDifferenceV0[];
	versionOrder: EndoHarnessVersionOrderV0;
	previous: EndoCockpitObservationViewV0 | null;
	current: EndoCockpitObservationViewV0 | null;
	/** Whether a collection failure text is recorded. The text can name local paths and is not presented. */
	failure: "none" | "withheld";
}

export interface EndoCockpitNotificationViewV0 {
	ref: EndoCockpitRefV0;
	id: string;
	at: string;
	kind: EndoHarnessNotificationKindV0;
	changeId: string;
	/** The notice title, or ENDO_COCKPIT_WITHHELD_TEXT_V0 when it looks sensitive. */
	title: string;
	/** The notice's lines can embed local paths and failure text, so they are counted, not presented. */
	lineCount: number;
	linesWithheld: true;
}

export interface EndoCockpitRuntimeIdentityV0 {
	schemaVersion: "endo.cockpit-runtime-identity.v0";
	projectionVersion: string;
	source: EndoCockpitRegistrySourceV0;
	/** The runtime family the attachment records. */
	runtime: EndoCockpitClaimV0<string>;
	current: EndoCockpitFingerprintViewV0 | null;
	/** The latest recorded observation whose identity digest differs from the current one, or null. */
	previousDifferent: EndoCockpitFingerprintViewV0 | null;
	lastChange: EndoCockpitChangeViewV0 | null;
	lastNotification: EndoCockpitNotificationViewV0 | null;
	notes: EndoCockpitNoteV0[];
}

// ---------------------------------------------------------------------------------------------------------------
// Capability state
// ---------------------------------------------------------------------------------------------------------------

export interface EndoCockpitEvidenceViewV0 {
	ref: EndoCockpitRefV0;
	id: string;
	check: { name: string; version: string; kind: EndoCapabilityCheckKindV0 };
	at: string;
	/** The evidence record's own classification. */
	classification: EndoConformanceClassificationV0;
	dependencies: {
		fingerprintId: string;
		identityDigest: string;
		confidence: EndoHarnessIdentityConfidenceV0;
		adapterVersion: string;
		mappingVersion: string;
		suiteVersion: string;
		configurationDigest: string;
		extension: { id: string; version: string } | null;
	};
	/** The digests or evidence ids the classification rests on (opaque; their contents are not presented). */
	supporting: string[];
	/** The written expectation and observation are not presented. */
	withheld: string[];
}

export interface EndoCockpitCapabilityViewV0 {
	capability: string;
	/** The recorded status, verbatim. Never recomputed, strengthened or weakened here. */
	status: EndoCapabilityStatusV0;
	classification: EndoConformanceClassificationV0 | null;
	/** The recorded reason as the attachment wrote it, or ENDO_COCKPIT_WITHHELD_TEXT_V0 when it looks sensitive. */
	reason: string;
	requires: EndoCapabilityCheckKindV0;
	/** The evidence record the state cites, or null when unverified or when the cited record is not in the registry. */
	evidence: EndoCockpitEvidenceViewV0 | null;
	/** The limitations the cited evidence record states (each ENDO_COCKPIT_WITHHELD_TEXT_V0 when it looks sensitive). */
	limitations: string[];
	/** Derived reasons the recorded status cannot be taken at face value. Empty when records agree. */
	limits: { code: EndoCockpitLimitCodeV0; refs: EndoCockpitRefV0[] }[];
	ref: EndoCockpitRefV0;
}

export interface EndoCockpitCapabilityStateRecordV0 {
	ref: EndoCockpitRefV0;
	recordedAt: string;
	/** The fingerprint the state was derived for, or null when the runtime could not be identified. */
	fingerprintId: string | null;
	/** The latest fingerprint recorded, or null. */
	latestFingerprintId: string | null;
	/**
	 * Derived from the two ids above: "current" when equal, "stale" when both are known and differ (a newer observation
	 * was recorded without a following state), "unknown" otherwise.
	 */
	currency: "current" | "stale" | "unknown";
}

export interface EndoCockpitCapabilityStateV0 {
	schemaVersion: "endo.cockpit-capability-state.v0";
	projectionVersion: string;
	source: EndoCockpitRegistrySourceV0;
	/** The latest recorded state, or null when none is recorded (or the registry is not projectable). */
	state: EndoCockpitCapabilityStateRecordV0 | null;
	/** In the order the state records them. */
	capabilities: EndoCockpitCapabilityViewV0[];
	notes: EndoCockpitNoteV0[];
}

// ---------------------------------------------------------------------------------------------------------------
// Session timeline
// ---------------------------------------------------------------------------------------------------------------

export interface EndoCockpitUsageV0 {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number | null;
	reasoning: number | null;
}

export interface EndoCockpitTimelineEntryV0 {
	/** 1-based position in the event log: the ONLY ordering of the timeline. */
	storageSequence: number;
	eventId: string;
	kind: string;
	category: EndoCockpitCategoryV0;
	/** The event's own source class, verbatim. */
	source: EndoEventSourceV0;
	producer: string;
	/** The producer's own sequence: monotonic within one producer's stream only, never an ordering across entries. */
	producerSequence: number;
	/** The producer's clock reading. Not an ordering key: it may run backwards across entries. */
	recordedAt: string;
	sessionId: string | null;
	runId: string | null;
	experimentId: string | null;
	derivedFrom: string[];
	flags: EndoCockpitFlagV0[];
	/**
	 * The allowlisted payload fields this projection version presents for the kind. Empty for a kind with no approved
	 * field, whether the kind is recognised (envelope only) or not (flagged "unrecognized").
	 */
	fields: Record<string, EndoCockpitFieldV0>;
	/**
	 * Usage as recorded, or an "unavailable" claim where the kind can carry usage and this event does not, or null where
	 * the kind never carries usage.
	 */
	usage: { basis: "reported"; value: EndoCockpitUsageV0 } | { basis: "unavailable"; reason: string } | null;
	/** How many payload keys were not presented. */
	withheldFields: number;
}

export interface EndoCockpitSessionSummaryV0 {
	sessionId: string;
	firstStorageSequence: number;
	lastStorageSequence: number;
	entries: number;
}

export interface EndoCockpitSessionTimelineV0 {
	schemaVersion: "endo.cockpit-session-timeline.v0";
	projectionVersion: string;
	source: EndoCockpitEventLogSourceV0;
	order: "storage-ascending";
	/**
	 * The window: entries are those with afterSequence < storageSequence <= nextAfterSequence. `hasMore` is whether the
	 * source holds events beyond `nextAfterSequence` (`watermark.length > nextAfterSequence`), and null exactly when the
	 * source has no position (it could not be opened). A window after the end of the log is empty, `nextAfterSequence`
	 * stays at `afterSequence`, and `hasMore` is false.
	 */
	window: { afterSequence: number; nextAfterSequence: number; hasMore: boolean | null };
	entries: EndoCockpitTimelineEntryV0[];
	/** The sessions seen in this window, by first appearance. */
	sessions: EndoCockpitSessionSummaryV0[];
	/** Entries in the input whose event id repeated an earlier one; the repeat is not presented. */
	duplicatesIgnored: number;
	notes: EndoCockpitNoteV0[];
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------------------------

/**
 * Projections read from independent sources. `consistency` is the contract's own statement that they are NOT one atomic
 * snapshot: the event log and each registry were opened one after another, may have been written in between, and share
 * no sequence. The watermark in each projection's `source` is that source's own position at its own read.
 */
export interface EndoCockpitSnapshotV0 {
	schemaVersion: "endo.cockpit-snapshot.v0";
	projectionVersion: string;
	consistency: "independent-sources";
	timeline: EndoCockpitSessionTimelineV0;
	/** One entry per attachment found in the registry, by attachment name in code-unit order. */
	runtimes: { identity: EndoCockpitRuntimeIdentityV0; capabilities: EndoCockpitCapabilityStateV0 }[];
}

export type EndoCockpitRecordV0 =
	| EndoCockpitRuntimeIdentityV0
	| EndoCockpitCapabilityStateV0
	| EndoCockpitSessionTimelineV0
	| EndoCockpitSnapshotV0;

// ---------------------------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_TEXT = 4096;
/** The longest producer name presented; the event envelope accepts any length, so the projection cuts at this. */
export const ENDO_COCKPIT_MAX_PRODUCER_V0 = 512;
const MAX_PRODUCER = ENDO_COCKPIT_MAX_PRODUCER_V0;

function isPlain(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && isPlainJsonObjectV0(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

/** Exactly these keys: all present, no others. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return onlyKeys(value, keys) && keys.every((key) => Object.hasOwn(value, key));
}

function isText(value: unknown, max = MAX_TEXT): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

function isEvidenceId(value: unknown): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, "evidence");
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (list as readonly string[]).includes(value);
}

function arrayOf<T>(value: unknown, check: (item: unknown) => item is T): value is T[] {
	return Array.isArray(value) && value.every(check);
}

function nullable<T>(value: unknown, check: (item: unknown) => item is T): value is T | null {
	return value === null || check(value);
}

function isRef(value: unknown): value is EndoCockpitRefV0 {
	if (!isPlain(value)) return false;
	if (value.domain === "event-log") {
		return (
			exactKeys(value, ["domain", "storageSequence", "eventId"]) &&
			isCount(value.storageSequence) &&
			value.storageSequence >= 1 &&
			typeof value.eventId === "string" &&
			isEndoIdentifierV0(value.eventId, "event")
		);
	}
	if (value.domain === "harness-registry") {
		return (
			exactKeys(value, ["domain", "attachment", "kind", "index", "id"]) &&
			typeof value.attachment === "string" &&
			isWellFormedKindV0(value.attachment) &&
			oneOf(ENDO_COCKPIT_REGISTRY_KINDS_V0, value.kind) &&
			isCount(value.index) &&
			(value.id === null || isEvidenceId(value.id))
		);
	}
	return false;
}

const isRefs = (value: unknown): value is EndoCockpitRefV0[] => arrayOf(value, isRef);

function isClaim<T>(value: unknown, check: (item: unknown) => item is T): value is EndoCockpitClaimV0<T> {
	if (!isPlain(value) || !isRefs(value.refs)) return false;
	if (value.basis === "unavailable") return exactKeys(value, ["basis", "reason", "refs"]) && isText(value.reason);
	return (
		exactKeys(value, ["basis", "value", "refs"]) && oneOf(ENDO_COCKPIT_BASES_V0, value.basis) && check(value.value)
	);
}

function isField(value: unknown): value is EndoCockpitFieldV0 {
	if (!isPlain(value)) return false;
	if (value.basis === "unavailable") return exactKeys(value, ["basis", "reason"]) && isText(value.reason);
	return (
		exactKeys(value, ["basis", "value"]) &&
		oneOf(ENDO_COCKPIT_BASES_V0, value.basis) &&
		(value.value === null ||
			typeof value.value === "boolean" ||
			typeof value.value === "string" ||
			(typeof value.value === "number" && Number.isFinite(value.value)))
	);
}

function isNote(value: unknown): value is EndoCockpitNoteV0 {
	return (
		isPlain(value) &&
		exactKeys(value, ["code", "refs"]) &&
		oneOf(ENDO_COCKPIT_NOTE_CODES_V0, value.code) &&
		isRefs(value.refs)
	);
}

function isCondition(value: unknown): value is EndoCockpitSourceConditionV0 {
	if (!isPlain(value) || !exactKeys(value, ["state", "tornTail", "sealedAt", "error"])) return false;
	if (!oneOf(ENDO_COCKPIT_SOURCE_STATES_V0, value.state)) return false;
	const tail = value.tornTail;
	if (tail !== null) {
		if (!isPlain(tail) || !exactKeys(tail, ["bytes", "sha256"]) || !isCount(tail.bytes) || !isSha256(tail.sha256))
			return false;
	}
	if (value.sealedAt !== null && !(isCount(value.sealedAt) && value.sealedAt >= 1)) return false;
	const error = value.error;
	if (error !== null) {
		if (
			!isPlain(error) ||
			!exactKeys(error, ["kind", "message"]) ||
			!isText(error.kind, 128) ||
			!isText(error.message, 512)
		)
			return false;
	}
	// The state and what was found must agree: the contract never reports damage under a clean state or the reverse.
	switch (value.state) {
		case "absent":
		case "empty":
		case "readable":
			return tail === null && value.sealedAt === null && error === null;
		case "degraded":
			return (tail !== null || value.sealedAt !== null) && error === null;
		case "unopenable":
			return tail === null && value.sealedAt === null && error !== null;
	}
}

function isEventLogSource(value: unknown): value is EndoCockpitEventLogSourceV0 {
	if (!isPlain(value) || !exactKeys(value, ["domain", "condition", "watermark"])) return false;
	if (value.domain !== "event-log" || !isCondition(value.condition)) return false;
	const unopenable = value.condition.state === "unopenable";
	if (unopenable) return value.watermark === null;
	const mark = value.watermark;
	if (!isPlain(mark) || !exactKeys(mark, ["length", "lastEventId", "prefixDigest"]) || !isCount(mark.length))
		return false;
	// The state and the position must agree: a clean log with no events is absent or empty, never readable. (A log can be
	// degraded at zero events: a torn tail or a bad first frame leaves no verified prefix.)
	if (mark.length === 0)
		return mark.lastEventId === null && mark.prefixDigest === null && value.condition.state !== "readable";
	if (typeof mark.lastEventId !== "string" || !isEndoIdentifierV0(mark.lastEventId, "event")) return false;
	if (!isSha256(mark.prefixDigest)) return false;
	return value.condition.state !== "absent" && value.condition.state !== "empty";
}

function isRegistrySource(value: unknown): value is EndoCockpitRegistrySourceV0 {
	if (!isPlain(value) || !exactKeys(value, ["domain", "attachment", "condition", "watermark"])) return false;
	if (value.domain !== "harness-registry" || typeof value.attachment !== "string") return false;
	if (!isWellFormedKindV0(value.attachment) || !isCondition(value.condition)) return false;
	if (value.condition.state === "unopenable") return value.watermark === null;
	const mark = value.watermark;
	if (!isPlain(mark) || !exactKeys(mark, ["counts", "lastIds", "contentDigest"]) || !isSha256(mark.contentDigest))
		return false;
	if (!isPlain(mark.counts) || !exactKeys(mark.counts, ENDO_COCKPIT_REGISTRY_KINDS_V0)) return false;
	if (!isPlain(mark.lastIds) || !exactKeys(mark.lastIds, ENDO_COCKPIT_REGISTRY_KINDS_V0)) return false;
	let total = 0;
	for (const kind of ENDO_COCKPIT_REGISTRY_KINDS_V0) {
		const count = mark.counts[kind];
		const lastId = mark.lastIds[kind];
		if (!isCount(count)) return false;
		if (count === 0 && lastId !== null) return false;
		if (lastId !== null && !isEvidenceId(lastId)) return false;
		total += count;
	}
	// The state and the records must agree: an absent or empty registry holds none, and a registry with none is never
	// readable (it may be degraded: damage can leave no verified record).
	return total === 0
		? value.condition.state !== "readable"
		: value.condition.state === "readable" || value.condition.state === "degraded";
}

const CONFIDENCES = ["strong", "reduced"] as const;

function isObservationView(value: unknown): value is EndoCockpitObservationViewV0 {
	return (
		isPlain(value) &&
		exactKeys(value, ["fingerprintId", "identityDigest", "confidence", "version"]) &&
		isEvidenceId(value.fingerprintId) &&
		isSha256(value.identityDigest) &&
		oneOf(CONFIDENCES, value.confidence) &&
		nullable(value.version, (item): item is string => isText(item, 256))
	);
}

function isFingerprintView(value: unknown): value is EndoCockpitFingerprintViewV0 {
	return (
		isPlain(value) &&
		exactKeys(value, ["ref", "id", "observedAt", "identity", "version", "entrypoint", "package", "withheld"]) &&
		isRef(value.ref) &&
		isEvidenceId(value.id) &&
		typeof value.observedAt === "string" &&
		isIso8601UtcV0(value.observedAt) &&
		isClaim(
			value.identity,
			(item): item is { digest: string; confidence: string } =>
				isPlain(item) &&
				exactKeys(item, ["digest", "confidence"]) &&
				isSha256(item.digest) &&
				oneOf(CONFIDENCES, item.confidence),
		) &&
		isClaim(value.version, (item): item is string => isText(item, 256)) &&
		isClaim(
			value.entrypoint,
			(item): item is { sha256: string; bytes: number } =>
				isPlain(item) && exactKeys(item, ["sha256", "bytes"]) && isSha256(item.sha256) && isCount(item.bytes),
		) &&
		isClaim(
			value.package,
			(item): item is { name: string; version: string } =>
				isPlain(item) &&
				exactKeys(item, ["name", "version"]) &&
				isText(item.name, 256) &&
				isText(item.version, 256),
		) &&
		arrayOf(value.withheld, (item): item is string => isText(item, 128))
	);
}

function isChangeView(value: unknown): value is EndoCockpitChangeViewV0 {
	return (
		isPlain(value) &&
		exactKeys(value, ["ref", "id", "at", "kind", "differences", "versionOrder", "previous", "current", "failure"]) &&
		isRef(value.ref) &&
		isEvidenceId(value.id) &&
		typeof value.at === "string" &&
		isIso8601UtcV0(value.at) &&
		oneOf(ENDO_HARNESS_CHANGE_KINDS_V0, value.kind) &&
		arrayOf(value.differences, (item): item is EndoHarnessDifferenceV0 => oneOf(ENDO_HARNESS_DIFFERENCES_V0, item)) &&
		oneOf(ENDO_HARNESS_VERSION_ORDERS_V0, value.versionOrder) &&
		nullable(value.previous, isObservationView) &&
		nullable(value.current, isObservationView) &&
		(value.failure === "none" || value.failure === "withheld")
	);
}

function isNotificationView(value: unknown): value is EndoCockpitNotificationViewV0 {
	return (
		isPlain(value) &&
		exactKeys(value, ["ref", "id", "at", "kind", "changeId", "title", "lineCount", "linesWithheld"]) &&
		isRef(value.ref) &&
		isEvidenceId(value.id) &&
		isEvidenceId(value.changeId) &&
		typeof value.at === "string" &&
		isIso8601UtcV0(value.at) &&
		oneOf(ENDO_HARNESS_NOTIFICATION_KINDS_V0, value.kind) &&
		isText(value.title, 256) &&
		isCount(value.lineCount) &&
		value.linesWithheld === true
	);
}

function isEvidenceView(value: unknown): value is EndoCockpitEvidenceViewV0 {
	if (
		!isPlain(value) ||
		!exactKeys(value, ["ref", "id", "check", "at", "classification", "dependencies", "supporting", "withheld"])
	)
		return false;
	const check = value.check;
	const dependencies = value.dependencies;
	return (
		isRef(value.ref) &&
		isEvidenceId(value.id) &&
		isPlain(check) &&
		exactKeys(check, ["name", "version", "kind"]) &&
		isText(check.name, 256) &&
		isText(check.version, 64) &&
		oneOf(ENDO_CAPABILITY_CHECK_KINDS_V0, check.kind) &&
		typeof value.at === "string" &&
		isIso8601UtcV0(value.at) &&
		oneOf(ENDO_CONFORMANCE_CLASSIFICATIONS_V0, value.classification) &&
		isPlain(dependencies) &&
		exactKeys(dependencies, [
			"fingerprintId",
			"identityDigest",
			"confidence",
			"adapterVersion",
			"mappingVersion",
			"suiteVersion",
			"configurationDigest",
			"extension",
		]) &&
		isEvidenceId(dependencies.fingerprintId) &&
		isSha256(dependencies.identityDigest) &&
		oneOf(CONFIDENCES, dependencies.confidence) &&
		isText(dependencies.adapterVersion, 64) &&
		isText(dependencies.mappingVersion, 64) &&
		isText(dependencies.suiteVersion, 64) &&
		isSha256(dependencies.configurationDigest) &&
		nullable(
			dependencies.extension,
			(item): item is { id: string; version: string } =>
				isPlain(item) && exactKeys(item, ["id", "version"]) && isText(item.id, 256) && isText(item.version, 256),
		) &&
		arrayOf(value.supporting, (item): item is string => isSha256(item) || isEvidenceId(item)) &&
		arrayOf(value.withheld, (item): item is string => isText(item, 128))
	);
}

function isCapabilityView(value: unknown): value is EndoCockpitCapabilityViewV0 {
	return (
		isPlain(value) &&
		exactKeys(value, [
			"capability",
			"status",
			"classification",
			"reason",
			"requires",
			"evidence",
			"limitations",
			"limits",
			"ref",
		]) &&
		typeof value.capability === "string" &&
		isWellFormedKindV0(value.capability) &&
		oneOf(ENDO_CAPABILITY_STATUSES_V0, value.status) &&
		nullable(value.classification, (item): item is EndoConformanceClassificationV0 =>
			oneOf(ENDO_CONFORMANCE_CLASSIFICATIONS_V0, item),
		) &&
		isText(value.reason, 2048) &&
		oneOf(ENDO_CAPABILITY_CHECK_KINDS_V0, value.requires) &&
		nullable(value.evidence, isEvidenceView) &&
		arrayOf(value.limitations, (item): item is string => isText(item)) &&
		arrayOf(
			value.limits,
			(item): item is { code: EndoCockpitLimitCodeV0; refs: EndoCockpitRefV0[] } =>
				isPlain(item) &&
				exactKeys(item, ["code", "refs"]) &&
				oneOf(ENDO_COCKPIT_LIMIT_CODES_V0, item.code) &&
				isRefs(item.refs),
		) &&
		isRef(value.ref)
	);
}

function isUsage(value: unknown): value is EndoCockpitUsageV0 {
	return (
		isPlain(value) &&
		exactKeys(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "costTotal", "reasoning"]) &&
		[value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens].every(
			(item) => typeof item === "number" && Number.isFinite(item),
		) &&
		nullable(value.costTotal, (item): item is number => typeof item === "number" && Number.isFinite(item)) &&
		nullable(value.reasoning, (item): item is number => typeof item === "number" && Number.isFinite(item))
	);
}

function isTimelineEntry(value: unknown): value is EndoCockpitTimelineEntryV0 {
	if (
		!isPlain(value) ||
		!exactKeys(value, [
			"storageSequence",
			"eventId",
			"kind",
			"category",
			"source",
			"producer",
			"producerSequence",
			"recordedAt",
			"sessionId",
			"runId",
			"experimentId",
			"derivedFrom",
			"flags",
			"fields",
			"usage",
			"withheldFields",
		])
	)
		return false;
	if (!isCount(value.storageSequence) || value.storageSequence < 1) return false;
	if (typeof value.eventId !== "string" || !isEndoIdentifierV0(value.eventId, "event")) return false;
	if (!isText(value.kind, 128) || !oneOf(ENDO_COCKPIT_CATEGORIES_V0, value.category)) return false;
	if (!oneOf(ENDO_EVENT_SOURCES_V0, value.source) || !isText(value.producer, MAX_PRODUCER)) return false;
	// The event envelope accepts any non-negative integer sequence, safe or not: the contract must not be stricter.
	if (
		typeof value.producerSequence !== "number" ||
		!Number.isInteger(value.producerSequence) ||
		value.producerSequence < 0
	)
		return false;
	if (typeof value.recordedAt !== "string" || !isIso8601UtcV0(value.recordedAt)) return false;
	const id =
		(kind: "session" | "run" | "experiment") =>
		(item: unknown): item is string =>
			typeof item === "string" && isEndoIdentifierV0(item, kind);
	if (!nullable(value.sessionId, id("session")) || !nullable(value.runId, id("run"))) return false;
	if (!nullable(value.experimentId, id("experiment"))) return false;
	if (
		!arrayOf(
			value.derivedFrom,
			(item): item is string => typeof item === "string" && isEndoIdentifierV0(item, "event"),
		)
	)
		return false;
	if (!arrayOf(value.flags, (item): item is EndoCockpitFlagV0 => oneOf(ENDO_COCKPIT_FLAGS_V0, item))) return false;
	if (!isPlain(value.fields) || !Object.values(value.fields).every(isField)) return false;
	if (!Object.keys(value.fields).every((key) => isText(key, 128))) return false;
	if (!isCount(value.withheldFields)) return false;
	const usage = value.usage;
	if (usage === null) return true;
	if (!isPlain(usage)) return false;
	if (usage.basis === "unavailable") return exactKeys(usage, ["basis", "reason"]) && isText(usage.reason);
	return exactKeys(usage, ["basis", "value"]) && usage.basis === "reported" && isUsage(usage.value);
}

// ---------------------------------------------------------------------------------------------------------------
// Contextual reference validation (wire validation: consistency with the enclosing projection, not with the disk)
// ---------------------------------------------------------------------------------------------------------------

type RegistryRef = Extract<EndoCockpitRefV0, { domain: "harness-registry" }>;

/** Where the references of one registry projection must point: its attachment and, once it has a position, its counts. */
interface RefContext {
	attachment: string;
	counts: Record<EndoCockpitRegistryKindV0, number> | null;
	lastIds: Record<EndoCockpitRegistryKindV0, string | null> | null;
}

function contextOf(source: EndoCockpitRegistrySourceV0): RefContext {
	return {
		attachment: source.attachment,
		counts: source.watermark?.counts ?? null,
		lastIds: source.watermark?.lastIds ?? null,
	};
}

/**
 * A registry reference of one of `kinds` into THIS registry: the same attachment, a position inside the record count the
 * watermark states for the kind (the last position naming the watermark's last id), an id exactly when the kind has one
 * (a capability state has none). A source with no position (unopenable) has no records to refer to. An event-log
 * reference is never a registry reference.
 */
function isRegistryRef(
	value: unknown,
	ctx: RefContext,
	kinds: readonly EndoCockpitRegistryKindV0[],
): value is RegistryRef {
	if (!isRef(value) || value.domain !== "harness-registry") return false;
	if (value.attachment !== ctx.attachment || !kinds.includes(value.kind)) return false;
	if (ctx.counts === null || ctx.lastIds === null || value.index >= ctx.counts[value.kind]) return false;
	if (value.index === ctx.counts[value.kind] - 1 && value.id !== ctx.lastIds[value.kind]) return false;
	return value.kind === "state" ? value.id === null : value.id !== null;
}

/** Deep equality of two JSON values, independent of key order. */
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b))
		return (
			Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, at) => sameJson(item, b[at]))
		);
	if (!isPlain(a) || !isPlain(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
	);
}

function sameRef(a: unknown, b: unknown): boolean {
	if (!isRef(a) || !isRef(b)) return false;
	if (a.domain === "event-log")
		return b.domain === "event-log" && a.storageSequence === b.storageSequence && a.eventId === b.eventId;
	return (
		b.domain === "harness-registry" &&
		a.attachment === b.attachment &&
		a.kind === b.kind &&
		a.index === b.index &&
		a.id === b.id
	);
}

/** A view's own `ref` names a record of `kind` whose id is the view's id. */
function ownRefOk(view: { ref: unknown; id: string }, ctx: RefContext, kind: EndoCockpitRegistryKindV0): boolean {
	return isRegistryRef(view.ref, ctx, [kind]) && view.ref.id === view.id;
}

/** Every reference of the claim points at the record of `kind` with this id (the record the value was read from). */
function claimReadFrom(
	claim: { refs: EndoCockpitRefV0[] },
	ctx: RefContext,
	kind: EndoCockpitRegistryKindV0,
	id: string,
) {
	return claim.refs.every((ref) => isRegistryRef(ref, ctx, [kind]) && ref.id === id);
}

/** What kinds of record a note may point at, by code. An empty list means the note carries no reference. */
const NOTE_REF_KINDS: Readonly<Record<EndoCockpitNoteCodeV0, readonly EndoCockpitRegistryKindV0[]>> = {
	"no-fingerprint-recorded": [],
	"latest-change-not-for-latest-fingerprint": ["change", "fingerprint"],
	"latest-change-is-collection-failure": ["change"],
	"notification-change-missing": ["notification"],
	"runtime-disagreement": ["fingerprint", "change"],
	"foreign-attachment-record": ENDO_COCKPIT_REGISTRY_KINDS_V0,
	"duplicate-record-id": ENDO_COCKPIT_REGISTRY_KINDS_V0,
	"duplicate-capability": ["state"],
	"state-without-fingerprint": ["state"],
	"no-capability-state-recorded": [],
	"source-not-projectable": [],
};

function notesPointInto(notes: EndoCockpitNoteV0[], ctx: RefContext): boolean {
	return notes.every((note) => {
		const kinds = NOTE_REF_KINDS[note.code];
		return note.refs.every((ref) => isRegistryRef(ref, ctx, kinds));
	});
}

/** The limit codes' reference kinds. Every limit starts with the state reference of its capability. */
const LIMIT_REF_KINDS: Readonly<Record<EndoCockpitLimitCodeV0, readonly EndoCockpitRegistryKindV0[]>> = {
	"state-not-for-latest-fingerprint": ["state", "fingerprint"],
	"state-without-fingerprint": ["state"],
	"state-fingerprint-not-recorded": ["state"],
	"evidence-record-missing": ["state"],
	"evidence-capability-differs": ["state", "evidence"],
	"evidence-classification-differs": ["state", "evidence"],
	"evidence-identity-differs": ["state", "evidence", "fingerprint"],
	"evidence-reduced-identity": ["state", "evidence", "fingerprint"],
	"status-classification-mismatch": ["state"],
	"runtime-differs": ["state", "evidence", "fingerprint"],
	"evidence-check-insufficient": ["state", "evidence"],
};

function validateRegistryProjection(value: Record<string, unknown>, projectionVersion: string): boolean {
	if (value.projectionVersion !== projectionVersion || !isRegistrySource(value.source)) return false;
	return arrayOf(value.notes, isNote) && notesPointInto(value.notes, contextOf(value.source));
}

// ---------------------------------------------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------------------------------------------

function identityPointsInto(identity: EndoCockpitRuntimeIdentityV0, ctx: RefContext): boolean {
	for (const view of [identity.current, identity.previousDifferent]) {
		if (view === null) continue;
		if (!ownRefOk(view, ctx, "fingerprint")) return false;
		if (
			![view.identity, view.version, view.entrypoint, view.package].every((c) =>
				claimReadFrom(c, ctx, "fingerprint", view.id),
			)
		)
			return false;
	}
	if (identity.lastChange !== null && !ownRefOk(identity.lastChange, ctx, "change")) return false;
	if (identity.lastNotification !== null && !ownRefOk(identity.lastNotification, ctx, "notification")) return false;
	// The runtime family is read from the current fingerprint, else from the last change; it names that record.
	const runtime = identity.runtime;
	if (runtime.basis === "unavailable") return runtime.refs.length === 0;
	const from = identity.current ?? identity.lastChange;
	return from !== null && runtime.refs.length === 1 && sameRef(runtime.refs[0], from.ref);
}

/** Validates a runtime identity projection (closed record, strict). Returns the value unchanged, or null. */
export function validateEndoCockpitRuntimeIdentityV0(value: unknown): EndoCockpitRuntimeIdentityV0 | null {
	if (
		!isPlain(value) ||
		!exactKeys(value, [
			"schemaVersion",
			"projectionVersion",
			"source",
			"runtime",
			"current",
			"previousDifferent",
			"lastChange",
			"lastNotification",
			"notes",
		])
	)
		return null;
	if (value.schemaVersion !== "endo.cockpit-runtime-identity.v0") return null;
	if (!validateRegistryProjection(value, ENDO_COCKPIT_PROJECTION_VERSIONS_V0.runtimeIdentity)) return null;
	if (!isClaim(value.runtime, (item): item is string => typeof item === "string" && isWellFormedKindV0(item)))
		return null;
	if (!nullable(value.current, isFingerprintView) || !nullable(value.previousDifferent, isFingerprintView))
		return null;
	if (!nullable(value.lastChange, isChangeView) || !nullable(value.lastNotification, isNotificationView)) return null;
	const identity = value as unknown as EndoCockpitRuntimeIdentityV0;
	return identityPointsInto(identity, contextOf(identity.source)) ? identity : null;
}

function capabilityPointsInto(projection: EndoCockpitCapabilityStateV0, ctx: RefContext): boolean {
	const state = projection.state;
	if (state === null) return true;
	if (!isRegistryRef(state.ref, ctx, ["state"])) return false;
	// The currency is derived from the two ids it sits beside.
	const expected =
		state.fingerprintId === null || state.latestFingerprintId === null
			? "unknown"
			: state.fingerprintId === state.latestFingerprintId
				? "current"
				: "stale";
	if (state.currency !== expected) return false;
	for (const capability of projection.capabilities) {
		if (!sameRef(capability.ref, state.ref)) return false;
		const evidence = capability.evidence;
		if (evidence !== null && !ownRefOk(evidence, ctx, "evidence")) return false;
		for (const limit of capability.limits) {
			const kinds = LIMIT_REF_KINDS[limit.code];
			// Every limit starts with the state it qualifies; its other references name the cited evidence and the
			// fingerprints the state itself names.
			if (limit.refs.length === 0 || !sameRef(limit.refs[0], state.ref)) return false;
			for (const ref of limit.refs) {
				if (!isRegistryRef(ref, ctx, kinds)) return false;
				if (ref.kind === "evidence" && (evidence === null || !sameRef(ref, evidence.ref))) return false;
				if (ref.kind === "fingerprint") {
					const allowed =
						limit.code === "state-not-for-latest-fingerprint"
							? [state.latestFingerprintId]
							: limit.code === "runtime-differs"
								? [state.fingerprintId, state.latestFingerprintId]
								: [state.fingerprintId];
					if (ref.id === null || !allowed.includes(ref.id)) return false;
				}
			}
		}
	}
	return true;
}

/** Validates a capability state projection. Returns the value unchanged, or null. */
export function validateEndoCockpitCapabilityStateV0(value: unknown): EndoCockpitCapabilityStateV0 | null {
	if (
		!isPlain(value) ||
		!exactKeys(value, ["schemaVersion", "projectionVersion", "source", "state", "capabilities", "notes"])
	)
		return null;
	if (value.schemaVersion !== "endo.cockpit-capability-state.v0") return null;
	if (!validateRegistryProjection(value, ENDO_COCKPIT_PROJECTION_VERSIONS_V0.capabilityState)) return null;
	const state = value.state;
	if (state !== null) {
		if (
			!isPlain(state) ||
			!exactKeys(state, ["ref", "recordedAt", "fingerprintId", "latestFingerprintId", "currency"])
		)
			return null;
		if (!isRef(state.ref) || typeof state.recordedAt !== "string" || !isIso8601UtcV0(state.recordedAt)) return null;
		if (!nullable(state.fingerprintId, isEvidenceId) || !nullable(state.latestFingerprintId, isEvidenceId))
			return null;
		if (state.currency !== "current" && state.currency !== "stale" && state.currency !== "unknown") return null;
	}
	if (!arrayOf(value.capabilities, isCapabilityView)) return null;
	if (state === null && value.capabilities.length > 0) return null;
	const seen = new Set<string>();
	for (const capability of value.capabilities as EndoCockpitCapabilityViewV0[]) {
		if (seen.has(capability.capability)) return null;
		seen.add(capability.capability);
	}
	const projection = value as unknown as EndoCockpitCapabilityStateV0;
	return capabilityPointsInto(projection, contextOf(projection.source)) ? projection : null;
}

/** Validates a session timeline projection, including that its entries follow storage order inside the window. */
export function validateEndoCockpitSessionTimelineV0(value: unknown): EndoCockpitSessionTimelineV0 | null {
	if (
		!isPlain(value) ||
		!exactKeys(value, [
			"schemaVersion",
			"projectionVersion",
			"source",
			"order",
			"window",
			"entries",
			"sessions",
			"duplicatesIgnored",
			"notes",
		])
	)
		return null;
	if (value.schemaVersion !== "endo.cockpit-session-timeline.v0" || value.order !== "storage-ascending") return null;
	if (value.projectionVersion !== ENDO_COCKPIT_PROJECTION_VERSIONS_V0.sessionTimeline) return null;
	if (!isEventLogSource(value.source) || !isCount(value.duplicatesIgnored) || !arrayOf(value.notes, isNote))
		return null;
	// A timeline's notes can only point into the event log it was read from.
	if (!value.notes.every((note) => note.refs.every((ref) => ref.domain === "event-log"))) return null;
	const window = value.window;
	if (!isPlain(window) || !exactKeys(window, ["afterSequence", "nextAfterSequence", "hasMore"])) return null;
	if (!isCount(window.afterSequence) || !isCount(window.nextAfterSequence)) return null;
	if (window.nextAfterSequence < window.afterSequence) return null;
	if (window.hasMore !== null && typeof window.hasMore !== "boolean") return null;
	if (!arrayOf(value.entries, isTimelineEntry)) return null;
	const mark = value.source.watermark;
	// `hasMore` is a statement about the source's position: absent exactly when the source has none, else it must agree
	// with the watermark. A cursor past the end is a valid empty window (the event store answers it so), not an error.
	if (mark === null) {
		if (window.hasMore !== null || value.entries.length > 0 || window.nextAfterSequence !== window.afterSequence)
			return null;
	} else if (window.hasMore !== mark.length > window.nextAfterSequence) return null;
	let previous = window.afterSequence;
	const ids = new Set<string>();
	for (const entry of value.entries as EndoCockpitTimelineEntryV0[]) {
		if (entry.storageSequence <= previous || entry.storageSequence > window.nextAfterSequence) return null;
		// No entry can lie beyond the events the source holds.
		if (mark !== null && entry.storageSequence > mark.length) return null;
		if (ids.has(entry.eventId)) return null;
		ids.add(entry.eventId);
		previous = entry.storageSequence;
	}
	// The cursor stops at the last event read. An ignored duplicate is read but not presented, so it can move the cursor
	// past the last entry; without one the cursor is exactly the last entry's position (or where the window started).
	if (value.duplicatesIgnored === 0 && window.nextAfterSequence !== previous) return null;
	else if (value.duplicatesIgnored > 0) {
		if (window.nextAfterSequence <= window.afterSequence) return null;
		if (mark !== null && window.nextAfterSequence > mark.length) return null;
	}
	const sessions = value.sessions;
	if (
		!arrayOf(
			sessions,
			(item): item is EndoCockpitSessionSummaryV0 =>
				isPlain(item) &&
				exactKeys(item, ["sessionId", "firstStorageSequence", "lastStorageSequence", "entries"]) &&
				typeof item.sessionId === "string" &&
				isEndoIdentifierV0(item.sessionId, "session") &&
				isCount(item.firstStorageSequence) &&
				isCount(item.lastStorageSequence) &&
				isCount(item.entries) &&
				item.firstStorageSequence <= item.lastStorageSequence,
		)
	)
		return null;
	// The summaries are exactly what the presented entries give: nothing more, nothing different, in first-appearance order.
	const expected = new Map<string, EndoCockpitSessionSummaryV0>();
	for (const entry of value.entries as EndoCockpitTimelineEntryV0[]) {
		if (entry.sessionId === null) continue;
		const summary = expected.get(entry.sessionId);
		if (summary === undefined)
			expected.set(entry.sessionId, {
				sessionId: entry.sessionId,
				firstStorageSequence: entry.storageSequence,
				lastStorageSequence: entry.storageSequence,
				entries: 1,
			});
		else {
			summary.lastStorageSequence = entry.storageSequence;
			summary.entries += 1;
		}
	}
	if (!sameJson(sessions, [...expected.values()])) return null;
	return value as unknown as EndoCockpitSessionTimelineV0;
}

/** Validates a snapshot and each projection in it; a snapshot never mixes attachments inside one runtime entry. */
export function validateEndoCockpitSnapshotV0(value: unknown): EndoCockpitSnapshotV0 | null {
	if (
		!isPlain(value) ||
		!exactKeys(value, ["schemaVersion", "projectionVersion", "consistency", "timeline", "runtimes"])
	)
		return null;
	if (value.schemaVersion !== "endo.cockpit-snapshot.v0" || value.consistency !== "independent-sources") return null;
	if (value.projectionVersion !== ENDO_COCKPIT_PROJECTION_VERSIONS_V0.snapshot) return null;
	if (validateEndoCockpitSessionTimelineV0(value.timeline) === null) return null;
	if (!Array.isArray(value.runtimes)) return null;
	const seen = new Set<string>();
	for (const runtime of value.runtimes) {
		if (!isPlain(runtime) || !exactKeys(runtime, ["identity", "capabilities"])) return null;
		const identity = validateEndoCockpitRuntimeIdentityV0(runtime.identity);
		const capabilities = validateEndoCockpitCapabilityStateV0(runtime.capabilities);
		if (identity === null || capabilities === null) return null;
		// Both views of one attachment come from one read of its registry: the same condition and the same position.
		if (!sameJson(identity.source, capabilities.source)) return null;
		if (seen.has(identity.source.attachment)) return null;
		seen.add(identity.source.attachment);
	}
	return value as unknown as EndoCockpitSnapshotV0;
}

/** The cockpit record versions this reader knows, each read by its own validator. */
export const ENDO_COCKPIT_VERSIONS_V0 = defineEndoVersionTableV0<EndoCockpitRecordV0>("endo.cockpit", [
	["endo.cockpit-runtime-identity.v0", validateEndoCockpitRuntimeIdentityV0],
	["endo.cockpit-capability-state.v0", validateEndoCockpitCapabilityStateV0],
	["endo.cockpit-session-timeline.v0", validateEndoCockpitSessionTimelineV0],
	["endo.cockpit-snapshot.v0", validateEndoCockpitSnapshotV0],
]);

/** Read a cockpit record under the version it declares; an unknown version is `unsupported-version`, never accepted. */
export function readEndoCockpitRecordV0(value: unknown): EndoVersionedReadV0<EndoCockpitRecordV0> {
	return readEndoVersionedV0(ENDO_COCKPIT_VERSIONS_V0, value);
}
