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

import {
	ENDO_COCKPIT_ANOMALY_KINDS_V0,
	ENDO_COCKPIT_CHECK_COST_V0,
	ENDO_COCKPIT_DISCONTINUITY_KINDS_V0,
	ENDO_COCKPIT_FINGERPRINT_GAP_REASON_V0,
	ENDO_COCKPIT_INTERRUPTION_KINDS_V0,
	ENDO_COCKPIT_KEYED_DIGEST_FIELDS_V0,
	ENDO_COCKPIT_MAX_DECLARED_UNAVAILABLE_V0,
	ENDO_COCKPIT_NO_RUNTIME_REASON_V0,
	ENDO_COCKPIT_PAYLOAD_FLAG_KINDS_V0,
	ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0,
	ENDO_COCKPIT_USAGE_REASONS_V0,
	ENDO_COCKPIT_WITHHELD_EVIDENCE_FIELDS_V0,
	ENDO_COCKPIT_WITHHELD_FINGERPRINT_FIELDS_V0,
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	endoCockpitEvidenceVsFingerprintV0,
	endoCockpitFieldRuleV0,
	endoCockpitGapNameAdmittedV0,
	endoCockpitKindUnrecognizedV0,
	endoCockpitProducerAdmittedV0,
	endoCockpitTextPresentableV0,
	endoCockpitTextUnsafeV0,
	endoCockpitUnavailableAdmittedV0,
	endoCockpitUnreadableRuntimeReasonV0,
	endoCockpitWithheldLowerBoundV0,
	isEndoCockpitPublicIdV0,
} from "./cockpit-fields.ts";

export { ENDO_COCKPIT_WITHHELD_TEXT_V0 } from "./cockpit-fields.ts";

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
	endoCapabilityStatusForV0,
} from "./harness.ts";
import { type EndoIdentifierKindV0, isWellFormedEventKindV0, isWellFormedKindV0 } from "./identity.ts";
import { ENDO_DIGEST_KEY_ID_PATTERN_V0 } from "./keyed-digest-shape.ts";
import { isIso8601UtcV0, isPlainJsonObjectV0 } from "./primitives.ts";
import { defineEndoVersionTableV0, type EndoVersionedReadV0, readEndoVersionedV0 } from "./versioned.ts";

// ---------------------------------------------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------------------------------------------

/** The projection definition versions of this contract version. A change to what a projection computes bumps its own. */
export const ENDO_COCKPIT_PROJECTION_VERSIONS_V0 = {
	runtimeIdentity: "cockpit-runtime-identity.3",
	capabilityState: "cockpit-capability-state.3",
	sessionTimeline: "cockpit-session-timeline.3",
	snapshot: "cockpit-snapshot.3",
} as const;

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

/**
 * The public errors of an unopenable source: a closed set of diagnostic categories, each with ONE fixed message. Nothing
 * a store or a record said is ever public (an Error message can quote an identifier, a path or a record's own text), so a
 * condition carries a category and the sentence that category always has. The validator requires exactly this pair.
 */
export const ENDO_COCKPIT_SOURCE_ERRORS_V0 = {
	"schema-not-an-object": "a stored record is not an object",
	"schema-missing-version": "a stored record declares no schema version",
	"schema-version-not-string": "a stored record declares a schema version that is not a string",
	"schema-unsupported-version": "a stored record declares a schema version this reader does not support",
	"schema-invalid": "a stored record does not satisfy the schema version it declares",
	unreadable: "the log file exists but cannot be read",
	"path-not-a-file": "the log path is not a regular file",
	"path-unreadable": "the log path cannot be read",
	"path-dangling-symlink": "the log path goes through a dangling symlink",
	"duplicate-id": "a stored record repeats the identifier of an earlier record",
	sealed: "the store is sealed: a frame failed verification",
	"record-misplaced": "a stored record does not belong where it was found",
	"unknown-record-kind": "a stored record is of a kind this reader does not know",
	"malformed-frame": "a stored frame is not in the form the store writes",
	"invalid-record": "a stored record is not valid",
	"invalid-store": "the store could not be opened",
} as const;
export type EndoCockpitSourceErrorKindV0 = keyof typeof ENDO_COCKPIT_SOURCE_ERRORS_V0;

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

/**
 * The limit codes, in the ORDER a capability lists them (each at most once): the projection emits in this order and the
 * validator requires it, so a limit list has one canonical form.
 */
export const ENDO_COCKPIT_LIMIT_CODES_V0 = [
	"state-not-for-latest-fingerprint",
	"state-without-fingerprint",
	"status-classification-mismatch",
	"state-fingerprint-not-recorded",
	"runtime-differs",
	"evidence-record-missing",
	"evidence-check-insufficient",
	"evidence-capability-differs",
	"evidence-classification-differs",
	"evidence-identity-differs",
	"evidence-confidence-differs",
	"evidence-reduced-identity",
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

/** The category of a kind: its first dotted segment when that is in the vocabulary, else "other". The one definition. */
export function endoCockpitCategoryOfV0(kind: string): EndoCockpitCategoryV0 {
	const dot = kind.indexOf(".");
	const segment = dot === -1 ? kind : kind.slice(0, dot);
	return (ENDO_COCKPIT_CATEGORIES_V0 as readonly string[]).includes(segment)
		? (segment as EndoCockpitCategoryV0)
		: "other";
}

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
	/**
	 * The torn tail left in place, or null: its length and a keyed token of its bytes (purpose `endo.cockpit.torn-tail.v0`
	 * under the read's digest key). The tail is data the cockpit withholds, so no plain hash of it is published.
	 */
	tornTail: { bytes: number; digest: string } | null;
	/** The 1-based index of the first frame that failed verification, or null. Writes to a sealed store are refused. */
	sealedAt: number | null;
	error: { kind: EndoCockpitSourceErrorKindV0; message: string } | null;
}

/**
 * The event log's position. `length` events were read, the last of them `lastEventId`; `prefixDigest` binds the complete
 * content of those events, in storage order, under the digest key the read was made with (`keyId`): the HMAC of
 * `{ purpose: "endo.cockpit.event-prefix.v0", length, chain }`, where `chain` is the sha256 over one line per event, each
 * line the lowercase hex sha256 of the event's canonical JSON followed by "\n" (kept internal: it commits to withheld
 * content, so it is never published). The same token over the first `length` events of a later read, under the same key,
 * proves the held prefix is still the prefix, even when an event was replaced under the same id; without the key it can
 * be neither recomputed nor confirmed against a guess. A consumer continues from `afterSequence = its length` only after
 * that check (cockpit/reader.ts, checkEndoCockpitSourceFreshnessV0). `lastEventId` and `prefixDigest` are null for an
 * empty log.
 */
export interface EndoCockpitEventLogWatermarkV0 {
	length: number;
	lastEventId: string | null;
	prefixDigest: string | null;
	/** The id of the digest key the tokens of this source were made under (never the key). */
	keyId: string;
}

export interface EndoCockpitEventLogSourceV0 {
	domain: "event-log";
	condition: EndoCockpitSourceConditionV0;
	/** Null exactly when the log could not be opened. */
	watermark: EndoCockpitEventLogWatermarkV0 | null;
}

/**
 * One attachment's registry position. The registry has no cursor, so a change of any part means re-reading the
 * attachment's registry; `contentDigest` is the keyed token (purpose `endo.cockpit.registry-content.v0`, under the digest key
 * of `keyId`) of the canonical JSON of its records, kind by kind, in append order, so equal watermarks under one key mean
 * equal records. A registry with no records commits to nothing, so its digest is a fixed unkeyed constant (the sha256 of
 * `{}` when absent, of the five empty lists when opened).
 */
export interface EndoCockpitRegistryWatermarkV0 {
	counts: Record<EndoCockpitRegistryKindV0, number>;
	lastIds: Record<EndoCockpitRegistryKindV0, string | null>;
	contentDigest: string;
	/** The id of the digest key the tokens of this source were made under (never the key). */
	keyId: string;
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

/** The bases a v0 record may carry. "inferred" is reserved in the vocabulary and produced by no v0 projection. */
const V0_BASES = ENDO_COCKPIT_BASES_V0.filter((basis) => basis !== "inferred");

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

function isKeyId(value: unknown): value is string {
	return typeof value === "string" && ENDO_DIGEST_KEY_ID_PATTERN_V0.test(value);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

/** A public identifier of the namespace: well formed, and of the shape an identifier may be presented in. */
function isPublicId(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoCockpitPublicIdV0(value, kind);
}

function isEvidenceId(value: unknown): value is string {
	return isPublicId(value, "evidence");
}

/** A dotted kind (a runtime family, an attachment, a capability) that is also not text the policy flags. */
function isKindLabel(value: unknown): value is string {
	return typeof value === "string" && isWellFormedKindV0(value) && !endoCockpitTextUnsafeV0(value);
}

/** A free-text label (a name, a version, a title, a reason): bounded and not unsafe. Withheld text is not unsafe. */
function isLabel(value: unknown, max = MAX_TEXT): value is string {
	return isText(value, max) && !endoCockpitTextUnsafeV0(value);
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
			isPublicId(value.eventId, "event")
		);
	}
	if (value.domain === "harness-registry") {
		return (
			exactKeys(value, ["domain", "attachment", "kind", "index", "id"]) &&
			typeof value.attachment === "string" &&
			isKindLabel(value.attachment) &&
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
	if (value.basis === "unavailable")
		return exactKeys(value, ["basis", "reason", "refs"]) && isLabel(value.reason, 256);
	return exactKeys(value, ["basis", "value", "refs"]) && oneOf(V0_BASES, value.basis) && check(value.value);
}

function isField(value: unknown): value is EndoCockpitFieldV0 {
	if (!isPlain(value)) return false;
	if (value.basis === "unavailable") return exactKeys(value, ["basis", "reason"]) && isLabel(value.reason, 256);
	return (
		exactKeys(value, ["basis", "value"]) &&
		oneOf(V0_BASES, value.basis) &&
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
		if (!isPlain(tail) || !exactKeys(tail, ["bytes", "digest"]) || !isCount(tail.bytes) || !isSha256(tail.digest))
			return false;
		// A torn tail is at least one byte of an incomplete frame, and the reader stops at the first corrupt frame without
		// looking past it, so a log is never both torn and sealed.
		if (tail.bytes < 1 || value.sealedAt !== null) return false;
	}
	if (value.sealedAt !== null && !(isCount(value.sealedAt) && value.sealedAt >= 1)) return false;
	const error = value.error;
	if (error !== null) {
		if (
			!isPlain(error) ||
			!exactKeys(error, ["kind", "message"]) ||
			typeof error.kind !== "string" ||
			!Object.hasOwn(ENDO_COCKPIT_SOURCE_ERRORS_V0, error.kind) ||
			error.message !== ENDO_COCKPIT_SOURCE_ERRORS_V0[error.kind as EndoCockpitSourceErrorKindV0]
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

/** The most positions one timeline page spans (equal to the event store's page maximum, which a test pins). */
export const ENDO_COCKPIT_PAGE_MAX_LIMIT_V0 = 10000;

function isEventLogSource(value: unknown): value is EndoCockpitEventLogSourceV0 {
	if (!isPlain(value) || !exactKeys(value, ["domain", "condition", "watermark"])) return false;
	if (value.domain !== "event-log" || !isCondition(value.condition)) return false;
	const unopenable = value.condition.state === "unopenable";
	if (unopenable) return value.watermark === null;
	const mark = value.watermark;
	if (!isPlain(mark) || !exactKeys(mark, ["length", "lastEventId", "prefixDigest", "keyId"]) || !isCount(mark.length))
		return false;
	if (!isKeyId(mark.keyId)) return false;
	// The state and the position must agree: a clean log with no events is absent or empty, never readable. (A log can be
	// degraded at zero events: a torn tail or a bad first frame leaves no verified prefix.)
	// The first frame that failed verification is the one right after the verified prefix.
	const sealedAt = value.condition.sealedAt;
	if (sealedAt !== null && sealedAt !== mark.length + 1) return false;
	if (mark.length === 0)
		return mark.lastEventId === null && mark.prefixDigest === null && value.condition.state !== "readable";
	if (typeof mark.lastEventId !== "string" || !isPublicId(mark.lastEventId, "event")) return false;
	if (!isSha256(mark.prefixDigest)) return false;
	return value.condition.state !== "absent" && value.condition.state !== "empty";
}

/** sha256 of the canonical JSON `{}` (an absent registry) and of the five empty record lists (an opened, empty one). */
const ABSENT_REGISTRY_DIGEST = "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356";
const EMPTY_REGISTRY_DIGEST = "de9bc43d669ccacd726cb1594bcf67f047f7c4daacdae8e78edfa4078ce27d59";

function isRegistrySource(value: unknown): value is EndoCockpitRegistrySourceV0 {
	if (!isPlain(value) || !exactKeys(value, ["domain", "attachment", "condition", "watermark"])) return false;
	if (value.domain !== "harness-registry" || typeof value.attachment !== "string") return false;
	if (!isKindLabel(value.attachment) || !isCondition(value.condition)) return false;
	if (value.condition.state === "unopenable") return value.watermark === null;
	const mark = value.watermark;
	if (
		!isPlain(mark) ||
		!exactKeys(mark, ["counts", "lastIds", "contentDigest", "keyId"]) ||
		!isSha256(mark.contentDigest)
	)
		return false;
	if (!isKeyId(mark.keyId)) return false;
	if (!isPlain(mark.counts) || !exactKeys(mark.counts, ENDO_COCKPIT_REGISTRY_KINDS_V0)) return false;
	if (!isPlain(mark.lastIds) || !exactKeys(mark.lastIds, ENDO_COCKPIT_REGISTRY_KINDS_V0)) return false;
	let total = 0;
	// Ids are unique across all kinds of a registry, and keyed presentation keeps equal ids equal: no two kinds end at one id.
	const lastIds = mark.lastIds as Record<EndoCockpitRegistryKindV0, string | null>;
	const lasts = ENDO_COCKPIT_REGISTRY_KINDS_V0.map((kind) => lastIds[kind]).filter((id) => id !== null);
	if (new Set(lasts).size !== lasts.length) return false;
	for (const kind of ENDO_COCKPIT_REGISTRY_KINDS_V0) {
		const count = mark.counts[kind];
		const lastId = mark.lastIds[kind];
		if (!isCount(count)) return false;
		if (count === 0 && lastId !== null) return false;
		if (lastId !== null && !isEvidenceId(lastId)) return false;
		// Every kind but a capability state has an id on each record, so a non-empty list names its last; a state has none.
		if (kind === "state" ? lastId !== null : count > 0 && lastId === null) return false;
		total += count;
	}
	// Each verified frame is one record, so the first frame that failed verification is the one after them.
	if (value.condition.sealedAt !== null && value.condition.sealedAt !== total + 1) return false;
	// The state and the records must agree: an absent or empty registry holds none, and a registry with none is never
	// readable (it may be degraded: damage can leave no verified record). The whole content is then known, so its digest
	// is too: an absent registry has no content to hash ({}), an opened one has five empty lists.
	if (total === 0) {
		if (value.condition.state === "readable") return false;
		return (
			mark.contentDigest === (value.condition.state === "absent" ? ABSENT_REGISTRY_DIGEST : EMPTY_REGISTRY_DIGEST)
		);
	}
	return value.condition.state === "readable" || value.condition.state === "degraded";
}

const CONFIDENCES = ["strong", "reduced"] as const;

function isObservationView(value: unknown): value is EndoCockpitObservationViewV0 {
	return (
		isPlain(value) &&
		exactKeys(value, ["fingerprintId", "identityDigest", "confidence", "version"]) &&
		isEvidenceId(value.fingerprintId) &&
		isSha256(value.identityDigest) &&
		oneOf(CONFIDENCES, value.confidence) &&
		nullable(value.version, (item): item is string => isLabel(item, 256))
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
		isClaim(value.version, (item): item is string => isLabel(item, 256)) &&
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
				isLabel(item.name, 256) &&
				isLabel(item.version, 256),
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
		(value.failure === "none" || value.failure === "withheld") &&
		changeIsCoherent(value as unknown as EndoCockpitChangeViewV0)
	);
}

/** The change kind, its two sides, its differences and its failure agree, as the harness change record requires. */
function changeIsCoherent(change: EndoCockpitChangeViewV0): boolean {
	if (new Set(change.differences).size !== change.differences.length) return false;
	const { previous, current } = change;
	switch (change.kind) {
		case "first-observation":
			return (
				previous === null &&
				current !== null &&
				change.differences.length === 0 &&
				change.failure === "none" &&
				change.versionOrder === "unknown"
			);
		case "unchanged":
			return (
				previous !== null &&
				current !== null &&
				change.differences.length === 0 &&
				change.failure === "none" &&
				previous.identityDigest === current.identityDigest
			);
		case "changed":
			return (
				previous !== null &&
				current !== null &&
				change.differences.length > 0 &&
				change.failure === "none" &&
				previous.identityDigest !== current.identityDigest
			);
		case "collection-failed":
			return (
				current === null &&
				change.differences.length === 0 &&
				change.failure === "withheld" &&
				change.versionOrder === "unknown"
			);
	}
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
		isLabel(value.title, 256) &&
		isCount(value.lineCount) &&
		value.lineCount >= 1 &&
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
		isLabel(check.name, 256) &&
		isLabel(check.version, 64) &&
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
		isLabel(dependencies.adapterVersion, 64) &&
		isLabel(dependencies.mappingVersion, 64) &&
		isLabel(dependencies.suiteVersion, 64) &&
		isSha256(dependencies.configurationDigest) &&
		nullable(
			dependencies.extension,
			(item): item is { id: string; version: string } =>
				isPlain(item) && exactKeys(item, ["id", "version"]) && isLabel(item.id, 256) && isLabel(item.version, 256),
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
		isKindLabel(value.capability) &&
		oneOf(ENDO_CAPABILITY_STATUSES_V0, value.status) &&
		nullable(value.classification, (item): item is EndoConformanceClassificationV0 =>
			oneOf(ENDO_CONFORMANCE_CLASSIFICATIONS_V0, item),
		) &&
		isLabel(value.reason, 256) &&
		oneOf(ENDO_CAPABILITY_CHECK_KINDS_V0, value.requires) &&
		nullable(value.evidence, isEvidenceView) &&
		arrayOf(value.limitations, (item): item is string => isLabel(item, 256)) &&
		// Limitations are the cited evidence's own: without evidence there are none. A classification is what separates an
		// unverified capability from every other status.
		(value.evidence !== null || (value.limitations as unknown[]).length === 0) &&
		(value.status === "unverified") === (value.classification === null) &&
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

/**
 * An entry shows only what the presentation policy allows for its kind: allowlisted fields (plus the runtime session
 * reference and declared gaps) with the policy's basis and value type, opaque values only in an admitted shape, the flags
 * its kind implies, usage only on a kind that can carry it, and a producer name only in an admitted shape or withheld.
 */
function entryFollowsPolicy(entry: EndoCockpitTimelineEntryV0): boolean {
	const { kind, fields } = entry;
	if (!endoCockpitProducerAdmittedV0(entry.producer) && entry.producer !== ENDO_COCKPIT_WITHHELD_TEXT_V0) return false;
	let declared = 0;
	for (const [key, field] of Object.entries(fields)) {
		const rule = endoCockpitFieldRuleV0(kind, key);
		if (rule?.dynamic === true) {
			declared += 1;
			if (declared > ENDO_COCKPIT_MAX_DECLARED_UNAVAILABLE_V0) return false;
		}
		if (rule === null) return false;
		if (rule.dynamic === true && !endoCockpitGapNameAdmittedV0(key.slice("unavailable.".length))) return false;
		if (field.basis === "unavailable") {
			if (!endoCockpitUnavailableAdmittedV0(kind, key, field.reason)) return false;
			continue;
		}
		if (rule.dynamic === true || field.basis !== rule.basis) return false;
		if (field.value === null) {
			if (!rule.nullable) return false;
		} else if (rule.type === "id") {
			if (typeof field.value !== "string" || !isEndoCockpitPublicIdV0(field.value)) return false;
		} else if (typeof field.value !== rule.type) return false;
		// Every presented string is judged whole and within the field bound, as the projection judged it.
		if (typeof field.value === "string" && !endoCockpitTextPresentableV0(field.value)) return false;
		if (rule.admitted !== undefined && typeof field.value === "string" && !rule.admitted(field.value)) return false;
	}
	// The two members of a keyed digest are shown together or not at all.
	for (const key of Object.keys(fields)) {
		if (!Object.hasOwn(ENDO_COCKPIT_KEYED_DIGEST_FIELDS_V0, key)) continue;
		if (fields[ENDO_COCKPIT_KEYED_DIGEST_FIELDS_V0[key]!.partner] === undefined) return false;
	}
	const runtimeSession = fields.runtimeSessionId;
	const conflict =
		kind === "harness.attached" &&
		runtimeSession?.basis === "unavailable" &&
		runtimeSession.reason === ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0;
	const has = (flag: EndoCockpitFlagV0) => entry.flags.includes(flag);
	if (has("interruption") !== ENDO_COCKPIT_INTERRUPTION_KINDS_V0.includes(kind)) return false;
	if (has("anomaly") !== (ENDO_COCKPIT_ANOMALY_KINDS_V0.includes(kind) || conflict)) return false;
	if (has("unrecognized") !== endoCockpitKindUnrecognizedV0(kind)) return false;
	// A flag a payload decides (a store reopened after damage) may be set or not; every other kind's is its kind's.
	if (
		!Object.hasOwn(ENDO_COCKPIT_PAYLOAD_FLAG_KINDS_V0, kind) &&
		has("discontinuity") !== ENDO_COCKPIT_DISCONTINUITY_KINDS_V0.includes(kind)
	)
		return false;
	// ... but where the entry shows what it was decided by, the flag follows it: set when any of the three is true, clear
	// when all three are shown false. (A value that is absent or unavailable is not read as false.)
	if (kind === "harness.store-opened") {
		const shown = ["recoveryTruncated", "recoveryRecovered", "recoverySealed"].map((key) => {
			const field = fields[key];
			return field !== undefined && field.basis !== "unavailable" && typeof field.value === "boolean"
				? field.value
				: undefined;
		});
		if (shown.includes(true) && !has("discontinuity")) return false;
		if (shown.every((item) => item === false) && has("discontinuity")) return false;
	}
	// Usage is present exactly when the event can carry it, decided by fields the entry itself presents. (A presented
	// `role` or `entryType` is a string that was judged presentable; one that was absent, withheld or unavailable is not the
	// word the projection tests for, so it never makes an event ineligible.) Whether the usage it carries is reported or
	// unavailable is not decidable from the wire and is left as the entry says.
	return (entry.usage !== null) === usageEligible(entry);
}

const USAGE_ENTRY_TYPES: readonly string[] = ["message", "compaction", "branch_summary", "usage"];

/** The presented string value of a field, or undefined when it is not presented as a value. */
function presentedString(entry: EndoCockpitTimelineEntryV0, key: string): string | undefined {
	const field = entry.fields[key];
	return field !== undefined && field.basis !== "unavailable" && typeof field.value === "string"
		? field.value
		: undefined;
}

/**
 * Whether the event can carry usage, as the projection decides it: an assistant (any non-user) message, and the durable
 * entries that record a model call, except a user message. No other kind can.
 */
function usageEligible(entry: EndoCockpitTimelineEntryV0): boolean {
	if (entry.kind === "message.completed") return presentedString(entry, "role") !== "user";
	if (entry.kind === "session.entry-observed") {
		const type = presentedString(entry, "entryType");
		if (type === undefined || !USAGE_ENTRY_TYPES.includes(type)) return false;
		return !(type === "message" && presentedString(entry, "role") === "user");
	}
	return false;
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
	if (typeof value.eventId !== "string" || !isPublicId(value.eventId, "event")) return false;
	if (typeof value.kind !== "string" || !isWellFormedEventKindV0(value.kind) || endoCockpitTextUnsafeV0(value.kind))
		return false;
	if (!oneOf(ENDO_COCKPIT_CATEGORIES_V0, value.category)) return false;
	// The category is defined by the kind; a record may not file an event under another.
	if (value.category !== endoCockpitCategoryOfV0(value.kind)) return false;
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
			isPublicId(item, kind);
	if (!nullable(value.sessionId, id("session")) || !nullable(value.runId, id("run"))) return false;
	if (!nullable(value.experimentId, id("experiment"))) return false;
	if (!arrayOf(value.derivedFrom, (item): item is string => isPublicId(item, "event"))) return false;
	if (!arrayOf(value.flags, (item): item is EndoCockpitFlagV0 => oneOf(ENDO_COCKPIT_FLAGS_V0, item))) return false;
	// Flags are listed once each, in the vocabulary's order.
	const flagOrder = (value.flags as EndoCockpitFlagV0[]).map((flag) => ENDO_COCKPIT_FLAGS_V0.indexOf(flag));
	if (!flagOrder.every((at, index) => index === 0 || flagOrder[index - 1]! < at)) return false;
	if (!isPlain(value.fields) || !Object.values(value.fields).every(isField)) return false;
	if (!Object.keys(value.fields).every((key) => isText(key, 128))) return false;
	if (!isCount(value.withheldFields)) return false;
	// What an entry may show is the presentation policy's (protocol/cockpit-fields.ts), the same one the projection applies.
	if (!entryFollowsPolicy(value as unknown as EndoCockpitTimelineEntryV0)) return false;
	// The counter is at least what the presented fields prove was left out (a nested path withholds its top-level key).
	const provenWithheld = endoCockpitWithheldLowerBoundV0(
		value.kind,
		value.fields as Record<string, { basis: string; reason?: unknown }>,
		// (A usage that is not a record is refused below; only its claim matters here.)
		isPlain(value.usage) ? (value.usage as { basis: string; reason?: unknown }) : null,
	);
	if (value.withheldFields < provenWithheld) return false;
	const usage = value.usage;
	if (usage === null) return true;
	if (!isPlain(usage)) return false;
	if (usage.basis === "unavailable")
		return (
			exactKeys(usage, ["basis", "reason"]) &&
			typeof usage.reason === "string" &&
			ENDO_COCKPIT_USAGE_REASONS_V0.includes(usage.reason) &&
			// Only an entry observation can lack its details; a message carries its usage (or not) directly.
			(usage.reason !== ENDO_COCKPIT_USAGE_REASONS_V0[0] || value.kind === "session.entry-observed")
		);
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
/** Whether the registry could be opened and read: records exist to project (an `absent` registry has none to read). */
function isProjectable(source: EndoCockpitRegistrySourceV0): boolean {
	return source.condition.state !== "absent" && source.condition.state !== "unopenable";
}

/** `source-not-projectable` is noted exactly when the source is not projectable. */
function projectableAgrees(source: EndoCockpitRegistrySourceV0, notes: EndoCockpitNoteV0[]): boolean {
	const noted = notes.filter((note) => note.code === "source-not-projectable").length;
	return isProjectable(source) ? noted === 0 : noted === 1;
}

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

/**
 * A fingerprint claim was read from exactly one record, the view's own: its references are that one reference and no
 * other. An empty list (no provenance) and an extra reference (provenance from somewhere else) both fail.
 */
function claimReadFromOwn(claim: { refs: EndoCockpitRefV0[] }, view: { ref: EndoCockpitRefV0 }): boolean {
	return claim.refs.length === 1 && sameRef(claim.refs[0], view.ref);
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

/**
 * The notes each registry projection may carry, and the record kinds it cleans (so the only kinds a foreign or repeated
 * record can be noted for). The diagnostics shared by both are the source's and the set-aside ones; a code belonging to
 * the other projection is never one this projection emits.
 */
const NOTE_POLICY: Readonly<
	Record<
		"runtimeIdentity" | "capabilityState",
		{ codes: readonly EndoCockpitNoteCodeV0[]; cleaned: readonly EndoCockpitRegistryKindV0[] }
	>
> = {
	runtimeIdentity: {
		codes: [
			"no-fingerprint-recorded",
			"latest-change-not-for-latest-fingerprint",
			"latest-change-is-collection-failure",
			"notification-change-missing",
			"runtime-disagreement",
			"foreign-attachment-record",
			"duplicate-record-id",
			"source-not-projectable",
		],
		cleaned: ["fingerprint", "change", "notification"],
	},
	capabilityState: {
		codes: [
			"foreign-attachment-record",
			"duplicate-record-id",
			"duplicate-capability",
			"state-without-fingerprint",
			"no-capability-state-recorded",
			"source-not-projectable",
		],
		cleaned: ["fingerprint", "evidence", "state"],
	},
};

function notesPointInto(notes: EndoCockpitNoteV0[], ctx: RefContext, projection: keyof typeof NOTE_POLICY): boolean {
	const policy = NOTE_POLICY[projection];
	// A record is discarded once: one cleaning note, of one code, per position (the cleaner emits exactly one disposition).
	const discarded = new Set<string>();
	const foreignFingerprints = new Set<number>(
		notes.flatMap((note) =>
			note.code === "foreign-attachment-record" &&
			note.refs[0]?.domain === "harness-registry" &&
			note.refs[0].kind === "fingerprint"
				? [note.refs[0].index]
				: [],
		),
	);
	return notes.every((note) => {
		if (!policy.codes.includes(note.code)) return false;
		const kinds = FOREIGN_OR_DUPLICATE.includes(note.code) ? policy.cleaned : NOTE_REF_KINDS[note.code];
		// A note about a discarded record names that one record, and only a record with an id can repeat one.
		if (FOREIGN_OR_DUPLICATE.includes(note.code)) {
			const [ref] = note.refs;
			if (note.refs.length !== 1 || ref === undefined) return false;
			if (note.code === "duplicate-record-id" && ref.domain === "harness-registry" && ref.id === null) return false;
			// Fingerprints are cleaned first, and a foreign one never enters the ledger: a fingerprint can repeat an id only
			// when some earlier fingerprint position is not foreign-noted (position 0 repeats nothing).
			if (
				note.code === "duplicate-record-id" &&
				ref.domain === "harness-registry" &&
				ref.kind === "fingerprint" &&
				!Array.from({ length: ref.index }, (_, before) => before).some((before) => !foreignFingerprints.has(before))
			)
				return false;
			if (ref.domain === "harness-registry") {
				const position = `${ref.kind}:${ref.index}`;
				if (discarded.has(position)) return false;
				discarded.add(position);
			}
		}
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
	"evidence-confidence-differs": ["state", "evidence", "fingerprint"],
};

function validateRegistryProjection(
	value: Record<string, unknown>,
	projectionVersion: string,
	projection: keyof typeof NOTE_POLICY,
): boolean {
	if (value.projectionVersion !== projectionVersion || !isRegistrySource(value.source)) return false;
	return arrayOf(value.notes, isNote) && notesPointInto(value.notes, contextOf(value.source), projection);
}

// ---------------------------------------------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------------------------------------------

const FOREIGN_OR_DUPLICATE: readonly string[] = ["foreign-attachment-record", "duplicate-record-id"];

/**
 * The position of the latest KEPT record of a kind, or null when none was kept: the highest position the cleaning notes
 * (foreign or repeated records, one note per discarded record) do not name. A kind never cleaned ends at its last position.
 */
function latestKeptIndex(notes: EndoCockpitNoteV0[], kind: EndoCockpitRegistryKindV0, count: number): number | null {
	const discarded = new Set<number>();
	for (const note of notes)
		if (FOREIGN_OR_DUPLICATE.includes(note.code))
			for (const ref of note.refs)
				if (ref.domain === "harness-registry" && ref.kind === kind) discarded.add(ref.index);
	for (let at = count - 1; at >= 0; at -= 1) if (!discarded.has(at)) return at;
	return null;
}

/**
 * The latest record of a kind is the latest one kept: absent exactly when none was kept, otherwise at that position. When
 * that is the last position the watermark names, it carries the last id (a capability state has no id, so its id is null);
 * an earlier position's id is not located by the watermark.
 */
function isLatest(
	kind: EndoCockpitRegistryKindV0,
	view: { ref: EndoCockpitRefV0 } | null,
	ctx: RefContext,
	notes: EndoCockpitNoteV0[],
): boolean {
	if (ctx.counts === null || ctx.lastIds === null) return true;
	const count = ctx.counts[kind];
	const kept = latestKeptIndex(notes, kind, count);
	if (view === null) return kept === null;
	const ref = view.ref;
	if (ref.domain !== "harness-registry" || kept === null || ref.index !== kept) return false;
	return kept !== count - 1 || ref.id === ctx.lastIds[kind];
}

/**
 * How many records of a kind the projection kept: the watermark's count less the positions the cleaning notes discarded
 * (one disposition per position). Null when the source has no position to count from.
 */
function retainedCount(notes: EndoCockpitNoteV0[], kind: EndoCockpitRegistryKindV0, ctx: RefContext): number | null {
	if (ctx.counts === null) return null;
	const discarded = new Set<number>();
	for (const note of notes)
		if (FOREIGN_OR_DUPLICATE.includes(note.code))
			for (const ref of note.refs)
				if (ref.domain === "harness-registry" && ref.kind === kind && ref.index < ctx.counts[kind])
					discarded.add(ref.index);
	return ctx.counts[kind] - discarded.size;
}

const notesOf = (notes: EndoCockpitNoteV0[], code: EndoCockpitNoteCodeV0) => notes.filter((note) => note.code === code);

/** A derived note is present exactly when its condition holds, once, with exactly the references the projection gives. */
function noteIs(
	notes: EndoCockpitNoteV0[],
	code: EndoCockpitNoteCodeV0,
	holds: boolean,
	refs: EndoCockpitRefV0[],
): boolean {
	const found = notesOf(notes, code);
	if (!holds) return found.length === 0;
	return (
		found.length === 1 &&
		found[0]!.refs.length === refs.length &&
		refs.every((ref, at) => sameRef(found[0]!.refs[at], ref))
	);
}

/** The notes of a runtime identity are true of the view they sit beside, wherever the wire decides them. */
function identityNotesAreTrue(identity: EndoCockpitRuntimeIdentityV0): boolean {
	const ctx = contextOf(identity.source);
	const { current, lastChange, lastNotification, notes } = identity;
	if (!isProjectable(identity.source)) return true;
	if (!noteIs(notes, "no-fingerprint-recorded", current === null, [])) return false;
	const failed = lastChange !== null && lastChange.kind === "collection-failed";
	if (!noteIs(notes, "latest-change-is-collection-failure", failed, lastChange === null ? [] : [lastChange.ref]))
		return false;
	const stray =
		lastChange !== null &&
		!failed &&
		current !== null &&
		(lastChange.current === null || lastChange.current.fingerprintId !== current.id);
	if (!noteIs(notes, "latest-change-not-for-latest-fingerprint", stray, stray ? [lastChange!.ref, current!.ref] : []))
		return false;
	// The notice's change is not among the changes: decided by the whole change list, which the view does not embed. What the
	// wire decides is that it needs a notice to speak of, with exactly its reference, and cannot be the last change.
	const missing = notesOf(notes, "notification-change-missing");
	if (missing.length > 1) return false;
	// With no change kept (none recorded, or every one discarded: the latest-record rule makes `lastChange` null exactly then),
	// the notice's change cannot be among them: the note is required, not just allowed.
	if (lastNotification !== null && identity.source.watermark !== null && lastChange === null && missing.length !== 1)
		return false;
	// With exactly one change kept, the notice's change is that one or nothing: a different id requires the note. (With
	// several kept, an earlier one may be the notice's: undecidable from the wire.)
	if (
		lastNotification !== null &&
		lastChange !== null &&
		retainedCount(notes, "change", ctx) === 1 &&
		lastChange.id !== lastNotification.changeId &&
		missing.length !== 1
	)
		return false;
	if (missing.length === 1) {
		if (
			lastNotification === null ||
			missing[0]!.refs.length !== 1 ||
			!sameRef(missing[0]!.refs[0], lastNotification.ref)
		)
			return false;
		if (lastChange !== null && lastChange.id === lastNotification.changeId) return false;
	}
	const disagreement = notesOf(notes, "runtime-disagreement");
	if (disagreement.length > 1 || disagreement.some((note) => note.refs.length < 2)) return false;
	// The projector cites one representative per distinct runtime family, so one record cited again establishes no disagreement.
	// (That the families differ is the source's to show, not the wire's.)
	if (
		disagreement.some((note) =>
			note.refs.some(
				(ref, at) =>
					ref.domain !== "harness-registry" ||
					note.refs.some(
						(other, to) =>
							to < at &&
							other.domain === "harness-registry" &&
							other.kind === ref.kind &&
							other.index === ref.index,
					),
			),
		)
	)
		return false;
	return true;
}

/** The notes of a capability state are true of the view they sit beside. */
function capabilityNotesAreTrue(projection: EndoCockpitCapabilityStateV0): boolean {
	const { state, notes } = projection;
	if (!isProjectable(projection.source)) return true;
	if (!noteIs(notes, "no-capability-state-recorded", state === null, [])) return false;
	const withoutFingerprint = state !== null && state.latestFingerprintId === null;
	if (!noteIs(notes, "state-without-fingerprint", withoutFingerprint, state === null ? [] : [state.ref])) return false;
	const duplicated = notesOf(notes, "duplicate-capability");
	if (
		duplicated.length > 0 &&
		(state === null ||
			// The first occurrence of a capability is kept: a later one is noted only beside it.
			projection.capabilities.length === 0 ||
			duplicated.some((note) => note.refs.length !== 1 || !sameRef(note.refs[0], state.ref)))
	)
		return false;
	return true;
}

/** Whether a foreign/duplicate note names, by its complete reference, a record that is also presented as a view. */
function discardsPresented(notes: EndoCockpitNoteV0[], presented: readonly (EndoCockpitRefV0 | null)[]): boolean {
	return notes.some(
		(note) =>
			FOREIGN_OR_DUPLICATE.includes(note.code) &&
			note.refs.some((ref) => presented.some((view) => view !== null && sameRef(view, ref))),
	);
}

/** Every registry reference anywhere in a value, however deep (a view's own, a claim's, a note's, a limit's). */
function registryRefsIn(value: unknown, found: RegistryRef[] = []): RegistryRef[] {
	if (Array.isArray(value)) for (const item of value) registryRefsIn(item, found);
	else if (isPlain(value)) {
		if (isRef(value) && value.domain === "harness-registry") found.push(value);
		else for (const item of Object.values(value)) registryRefsIn(item, found);
	}
	return found;
}

/** One position of one kind is one record: wherever it is named, it carries the same id. */
function positionsKeepIds(...values: unknown[]): boolean {
	const ids = new Map<string, string | null>();
	for (const ref of values.flatMap((value) => registryRefsIn(value))) {
		const position = `${ref.attachment}|${ref.kind}|${ref.index}`;
		if (ids.has(position) && ids.get(position) !== ref.id) return false;
		ids.set(position, ref.id);
	}
	return true;
}

/**
 * The evidence limits an embedded fingerprint decides. When the state names a fingerprint the identity view presents (its
 * current one, or the latest one with another identity), the snapshot holds both sides of each comparison - the evidence's
 * dependencies and the fingerprint's identity - so the limits that follow from them are required, and those they disprove
 * are refused, exactly as the capability projection derives them (the shared predicate). A state naming a fingerprint the
 * identity does not embed (a historical one) is not reasoned about: nothing is inferred from the current one.
 */
function evidenceLimitsAgreeWithFingerprint(
	identity: EndoCockpitRuntimeIdentityV0,
	capabilities: EndoCockpitCapabilityStateV0,
): boolean {
	const state = capabilities.state;
	if (state === null || state.fingerprintId === null) return true;
	const embedded = [identity.current, identity.previousDifferent].filter((view) => view !== null);
	const named = embedded.find((view) => view.id === state.fingerprintId);
	// The state names a fingerprint the identity embeds: it is recorded. Naming none, when every kept fingerprint is embedded
	// (their count is the retained count), it is not. Otherwise an older kept record may be the one: undecidable.
	const everyKeptEmbedded =
		retainedCount(capabilities.notes, "fingerprint", contextOf(capabilities.source)) === embedded.length;
	for (const capability of capabilities.capabilities) {
		if (capability.status === "unverified") continue;
		const unrecorded = capability.limits.some((limit) => limit.code === "state-fingerprint-not-recorded");
		if (named !== undefined && unrecorded) return false;
		if (named === undefined && everyKeptEmbedded && !unrecorded) return false;
	}
	if (named === undefined) return true;
	const identityClaim = named.identity;
	for (const capability of capabilities.capabilities) {
		const evidence = capability.evidence;
		if (capability.status === "unverified" || evidence === null) continue;
		const against = endoCockpitEvidenceVsFingerprintV0(evidence.dependencies, {
			id: named.id,
			identity: identityClaim.basis === "unavailable" ? null : identityClaim.value,
		});
		const limitOf = (code: EndoCockpitLimitCodeV0) => capability.limits.find((limit) => limit.code === code);
		const decided: [EndoCockpitLimitCodeV0, boolean | null][] = [
			["evidence-identity-differs", against.identityDiffers],
			["evidence-confidence-differs", against.confidenceDiffers],
			["evidence-reduced-identity", against.reducedIdentity],
		];
		for (const [code, expected] of decided) {
			const limit = limitOf(code);
			if (expected !== null && (limit !== undefined) !== expected) return false;
			// A limit about the fingerprint cites the one the state names, by its complete reference.
			if (limit !== undefined && !sameRef(limit.refs[2], named.ref)) return false;
		}
	}
	return true;
}

/**
 * How the cleaner disposed of each fingerprint record, as one view's notes say it: the complete reference of the record and
 * the reason it was set aside, in a canonical order. Both views of one registry read clean the same fingerprints.
 */
function fingerprintCleaning(notes: EndoCockpitNoteV0[]): string[] {
	return notes
		.filter((note) => FOREIGN_OR_DUPLICATE.includes(note.code))
		.flatMap((note) =>
			note.refs.flatMap((ref) =>
				ref.domain === "harness-registry" && ref.kind === "fingerprint"
					? [JSON.stringify([note.code, ref.attachment, ref.index, ref.id])]
					: [],
			),
		)
		.sort();
}

/**
 * Two presented views of different records never carry one id (ids are unique across all kinds of a registry, and keyed
 * presentation keeps equal ids equal). Views of one record - the same complete reference - are one appearance.
 */
function presentedIdsDistinct(views: readonly { ref: EndoCockpitRefV0; id: string }[]): boolean {
	return views.every((a, at) => views.every((b, to) => to <= at || sameRef(a.ref, b.ref) || a.id !== b.id));
}

function identityPointsInto(identity: EndoCockpitRuntimeIdentityV0, ctx: RefContext): boolean {
	if (!projectableAgrees(identity.source, identity.notes)) return false;
	if (
		!presentedIdsDistinct(
			[identity.current, identity.previousDifferent, identity.lastChange, identity.lastNotification].filter(
				(view) => view !== null,
			),
		)
	)
		return false;
	if (
		discardsPresented(identity.notes, [
			identity.current?.ref ?? null,
			identity.previousDifferent?.ref ?? null,
			identity.lastChange?.ref ?? null,
			identity.lastNotification?.ref ?? null,
		])
	)
		return false;
	if (!identityNotesAreTrue(identity)) return false;
	// `current`, the last change and the last notice are the records the watermark ends at.
	if (!isLatest("fingerprint", identity.current, ctx, identity.notes)) return false;
	if (!isLatest("change", identity.lastChange, ctx, identity.notes)) return false;
	if (!isLatest("notification", identity.lastNotification, ctx, identity.notes)) return false;
	if (
		identity.previousDifferent !== null &&
		identity.current !== null &&
		identity.previousDifferent.ref.domain === "harness-registry" &&
		identity.current.ref.domain === "harness-registry" &&
		identity.previousDifferent.ref.index >= identity.current.ref.index
	)
		return false;
	if (!isProjectable(identity.source)) {
		if (identity.current !== null || identity.previousDifferent !== null) return false;
		if (identity.lastChange !== null || identity.lastNotification !== null) return false;
	}
	// The latest different observation is, by definition, a different identity from the current one.
	if (identity.previousDifferent !== null) {
		if (identity.current === null) return false;
		// Two records of one registry never share an id.
		if (identity.previousDifferent.id === identity.current.id) return false;
		if (
			identity.previousDifferent.identity.basis === "derived" &&
			identity.current.identity.basis === "derived" &&
			identity.previousDifferent.identity.value.digest === identity.current.identity.value.digest
		)
			return false;
	}
	for (const view of [identity.current, identity.previousDifferent]) {
		if (view === null) continue;
		if (!ownRefOk(view, ctx, "fingerprint")) return false;
		// How each fact was established is fixed by what it is, and a gap says one of the two things the projection says.
		if (view.identity.basis !== "derived") return false;
		if (!claimIs(view.version, "reported", GAP_OR_WITHHELD)) return false;
		if (!claimIs(view.entrypoint, "observed", [ENDO_COCKPIT_FINGERPRINT_GAP_REASON_V0])) return false;
		if (!claimIs(view.package, "observed", GAP_OR_WITHHELD)) return false;
		if (!sameJson(view.withheld, ENDO_COCKPIT_WITHHELD_FINGERPRINT_FIELDS_V0)) return false;
		if (![view.identity, view.version, view.entrypoint, view.package].every((c) => claimReadFromOwn(c, view)))
			return false;
	}
	if (identity.lastChange !== null && !ownRefOk(identity.lastChange, ctx, "change")) return false;
	if (identity.lastNotification !== null && !ownRefOk(identity.lastNotification, ctx, "notification")) return false;
	// The runtime family is read from the current fingerprint, else from the last change; it names that record.
	const runtime = identity.runtime;
	if (runtime.basis !== "observed" && runtime.basis !== "unavailable") return false;
	if (runtime.basis === "unavailable") {
		// Unavailable exactly when no record names a family, with the reason for it.
		const expected = isProjectable(identity.source)
			? ENDO_COCKPIT_NO_RUNTIME_REASON_V0
			: endoCockpitUnreadableRuntimeReasonV0(identity.source.condition.state);
		// A family the text policy flags is withheld, whatever records name it.
		if (runtime.refs.length !== 0) return false;
		// (Only a record that names a family can have one to withhold.)
		if (runtime.reason === ENDO_COCKPIT_WITHHELD_TEXT_V0)
			return isProjectable(identity.source) && (identity.current !== null || identity.lastChange !== null);
		return runtime.reason === expected && identity.current === null && identity.lastChange === null;
	}
	const from = identity.current ?? identity.lastChange;
	return from !== null && runtime.refs.length === 1 && sameRef(runtime.refs[0], from.ref);
}

const GAP_OR_WITHHELD: readonly string[] = [ENDO_COCKPIT_FINGERPRINT_GAP_REASON_V0, ENDO_COCKPIT_WITHHELD_TEXT_V0];

/** A claim has this basis, or is unavailable for one of the reasons the projection gives. */
function claimIs(claim: { basis: string; reason?: string }, basis: string, reasons: readonly string[]): boolean {
	return claim.basis === basis || (claim.basis === "unavailable" && reasons.includes(claim.reason ?? ""));
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
	if (!validateRegistryProjection(value, ENDO_COCKPIT_PROJECTION_VERSIONS_V0.runtimeIdentity, "runtimeIdentity"))
		return null;
	if (!isClaim(value.runtime, (item): item is string => typeof item === "string" && isKindLabel(item))) return null;
	if (!nullable(value.current, isFingerprintView) || !nullable(value.previousDifferent, isFingerprintView))
		return null;
	if (!nullable(value.lastChange, isChangeView) || !nullable(value.lastNotification, isNotificationView)) return null;
	const identity = value as unknown as EndoCockpitRuntimeIdentityV0;
	return identityPointsInto(identity, contextOf(identity.source)) && positionsKeepIds(identity) ? identity : null;
}

/**
 * A capability's limits are derived reasons its recorded status cannot be taken at face value. Wire validation checks what
 * the wire itself decides: each limit appears at most once and in the canonical order; the limits whose precondition is
 * decided by values on the wire (a stale state, no cited evidence, a classification that differs, a status that does not
 * follow its classification, evidence from a cheaper check kind than required) appear EXACTLY when it holds; the others
 * (a record that is not in the registry, an identity digest, a runtime family or a confidence that differs from a
 * fingerprint the view does not embed) can only be checked for a possible precondition and for their exact references,
 * because deciding them needs the registry. A forged limit of that second kind with correct references is not detectable
 * from the wire: that is the store-verification boundary, not a gap in this check.
 */
function limitsAreSound(
	capability: EndoCockpitCapabilityViewV0,
	state: NonNullable<EndoCockpitCapabilityStateV0["state"]>,
	evidence: EndoCockpitEvidenceViewV0 | null,
	ctx: RefContext,
	retained: number | null,
): boolean {
	const { limits } = capability;
	let last = -1;
	for (const limit of limits) {
		const at = ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(limit.code);
		if (at <= last) return false;
		last = at;
	}
	const has = (code: EndoCockpitLimitCodeV0) => limits.some((limit) => limit.code === code);
	const admitted = capability.status !== "unverified";
	const fingerprintId = state.fingerprintId;
	const latestId = state.latestFingerprintId;
	const decided: Partial<Record<EndoCockpitLimitCodeV0, boolean>> = {
		"state-not-for-latest-fingerprint": admitted && state.currency === "stale",
		"state-without-fingerprint": admitted && latestId === null,
		"status-classification-mismatch":
			admitted &&
			capability.classification !== null &&
			endoCapabilityStatusForV0(capability.classification) !== capability.status,
		"evidence-record-missing": admitted && evidence === null,
		"evidence-check-insufficient":
			admitted &&
			evidence !== null &&
			(ENDO_COCKPIT_CHECK_COST_V0[evidence.check.kind] ?? 0) <
				(ENDO_COCKPIT_CHECK_COST_V0[capability.requires] ?? 0),
		"evidence-classification-differs":
			admitted && evidence !== null && evidence.classification !== capability.classification,
		// The state names the latest fingerprint (so the record exists), the evidence another one, and that evidence is
		// itself on a reduced identity: carried across observations, which the protocol never allows.
		"evidence-reduced-identity":
			admitted &&
			evidence !== null &&
			fingerprintId !== null &&
			fingerprintId === latestId &&
			evidence.dependencies.fingerprintId !== fingerprintId &&
			evidence.dependencies.confidence === "reduced",
	};
	for (const [code, expected] of Object.entries(decided))
		if (
			code === "evidence-reduced-identity"
				? expected && !has(code)
				: has(code as EndoCockpitLimitCodeV0) !== expected
		)
			return false;
	// With no fingerprint kept (none recorded, or every one discarded), or exactly one kept and it is not the one named, the
	// one the state names cannot be among them. With several kept, a different id may be an older kept record: not demanded.
	if (
		admitted &&
		fingerprintId !== null &&
		ctx.counts !== null &&
		(retained === 0 || (retained === 1 && fingerprintId !== latestId)) &&
		!has("state-fingerprint-not-recorded")
	)
		return false;
	const possible: Partial<Record<EndoCockpitLimitCodeV0, boolean>> = {
		"state-fingerprint-not-recorded": fingerprintId !== null && fingerprintId !== latestId,
		"evidence-capability-differs": evidence !== null,
		"evidence-identity-differs": evidence !== null && fingerprintId !== null,
		"evidence-confidence-differs": evidence !== null && fingerprintId !== null,
		"evidence-reduced-identity":
			evidence !== null && fingerprintId !== null && evidence.dependencies.fingerprintId !== fingerprintId,
		"runtime-differs": evidence !== null || fingerprintId !== null || latestId !== null,
	};
	const fingerprintRef = (ref: EndoCockpitRefV0 | undefined, id: string | null): boolean =>
		ref !== undefined && id !== null && isRegistryRef(ref, ctx, ["fingerprint"]) && ref.id === id;
	for (const limit of limits) {
		if (possible[limit.code] === false) return false;
		const [first, ...rest] = limit.refs;
		if (first === undefined || !sameRef(first, state.ref)) return false;
		if (!limit.refs.every((ref) => isRegistryRef(ref, ctx, LIMIT_REF_KINDS[limit.code]))) return false;
		const cited = evidence === null ? undefined : evidence.ref;
		switch (limit.code) {
			case "state-not-for-latest-fingerprint":
				if (rest.length !== 1 || !fingerprintRef(rest[0], latestId)) return false;
				break;
			case "state-without-fingerprint":
			case "state-fingerprint-not-recorded":
			case "evidence-record-missing":
			case "status-classification-mismatch":
				if (rest.length !== 0) return false;
				break;
			case "evidence-check-insufficient":
			case "evidence-capability-differs":
			case "evidence-classification-differs":
				if (rest.length !== 1 || cited === undefined || !sameRef(rest[0], cited)) return false;
				break;
			case "evidence-identity-differs":
			case "evidence-confidence-differs":
			case "evidence-reduced-identity":
				if (rest.length !== 2 || cited === undefined || !sameRef(rest[0], cited)) return false;
				if (!fingerprintRef(rest[1], fingerprintId)) return false;
				break;
			case "runtime-differs": {
				// The records whose family differs, in the order they are named: the cited evidence, the fingerprint the state
				// names, the latest fingerprint (when it is another record).
				let at = 0;
				let named = 0;
				if (cited !== undefined && rest[at] !== undefined && sameRef(rest[at], cited)) at += 1;
				if (rest[at] !== undefined && fingerprintRef(rest[at], fingerprintId)) {
					at += 1;
					named = 1;
				}
				if (
					rest[at] !== undefined &&
					fingerprintRef(rest[at], latestId) &&
					!(named === 1 && fingerprintId === latestId)
				)
					at += 1;
				if (at !== rest.length || rest.length === 0) return false;
				break;
			}
		}
	}
	return true;
}

function capabilityPointsInto(projection: EndoCockpitCapabilityStateV0, ctx: RefContext): boolean {
	if (!projectableAgrees(projection.source, projection.notes)) return false;
	if (
		discardsPresented(projection.notes, [
			projection.state?.ref ?? null,
			...projection.capabilities.map((view) => view.evidence?.ref ?? null),
		])
	)
		return false;
	if (!isProjectable(projection.source) && (projection.state !== null || projection.capabilities.length > 0))
		return false;
	if (!capabilityNotesAreTrue(projection)) return false;
	if (!isLatest("state", projection.state, ctx, projection.notes)) return false;
	// The latest fingerprint the state names beside its own is the one the watermark ends at.
	if (projection.state !== null && ctx.counts !== null && ctx.lastIds !== null) {
		// The latest fingerprint the state names beside its own is the latest one kept; the watermark locates its id only when
		// that is the last position.
		const kept = latestKeptIndex(projection.notes, "fingerprint", ctx.counts.fingerprint);
		const latest = projection.state.latestFingerprintId;
		if (
			kept === null
				? latest !== null
				: latest === null || (kept === ctx.counts.fingerprint - 1 && latest !== ctx.lastIds.fingerprint)
		)
			return false;
	}
	// An unverified capability cites no evidence, and none of the limits (which qualify an admitted status) apply to it.
	if (
		projection.capabilities.some(
			(c) => c.status === "unverified" && (c.evidence !== null || c.limits.length > 0 || c.classification !== null),
		)
	)
		return false;
	const state = projection.state;
	if (state === null) return true;
	if (!isRegistryRef(state.ref, ctx, ["state"])) return false;
	// An admitted capability is established for a fingerprint: the durable state refuses one without it. (Whether that record
	// is still in the registry is not decided here.)
	if (state.fingerprintId === null && projection.capabilities.some((c) => c.status !== "unverified")) return false;
	// The currency is derived from the two ids it sits beside.
	const expected =
		state.fingerprintId === null || state.latestFingerprintId === null
			? "unknown"
			: state.fingerprintId === state.latestFingerprintId
				? "current"
				: "stale";
	if (state.currency !== expected) return false;
	const retained = retainedCount(projection.notes, "fingerprint", ctx);
	const cited: EndoCockpitCapabilityViewV0[] = [];
	// The cited evidence records are records of one registry: no two share an id, and none shares the id of a fingerprint
	// the state names (a different kind of record).
	// `latestFingerprintId` is the id of a kept fingerprint record, and the cleaning ledger keeps ids unique across kinds, so no
	// kept evidence record shares it. (`fingerprintId` is only a reference the state carries, possibly to nothing recorded:
	// not compared.)
	const named = [state.latestFingerprintId].filter((id) => id !== null);
	const evidenceViews = projection.capabilities.flatMap((c) => (c.evidence === null ? [] : [c.evidence]));
	if (!presentedIdsDistinct(evidenceViews) || evidenceViews.some((view) => named.includes(view.id))) return false;
	for (const capability of projection.capabilities) {
		if (!sameRef(capability.ref, state.ref)) return false;
		// One evidence record is one view: capabilities citing the same record agree on everything about it. (Their `limits`
		// are about the capability, not the record, and may differ.)
		if (capability.evidence !== null) {
			const same = cited.find((other) => sameRef(other.evidence!.ref, capability.evidence!.ref));
			if (
				same !== undefined &&
				!(sameJson(same.evidence, capability.evidence) && sameJson(same.limitations, capability.limitations))
			)
				return false;
			if (same === undefined) cited.push(capability);
		}
		const evidence = capability.evidence;
		if (evidence !== null && !ownRefOk(evidence, ctx, "evidence")) return false;
		if (evidence !== null && !sameJson(evidence.withheld, ENDO_COCKPIT_WITHHELD_EVIDENCE_FIELDS_V0)) return false;
		if (!limitsAreSound(capability, state, evidence, ctx, retained)) return false;
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
	if (!validateRegistryProjection(value, ENDO_COCKPIT_PROJECTION_VERSIONS_V0.capabilityState, "capabilityState"))
		return null;
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
	return capabilityPointsInto(projection, contextOf(projection.source)) && positionsKeepIds(projection)
		? projection
		: null;
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
	// The only note a timeline carries is that its source could not be opened, and it carries it exactly then.
	if (value.notes.length !== (value.source.condition.state === "unopenable" ? 1 : 0)) return null;
	if (value.notes.some((note) => note.code !== "source-not-projectable")) return null;
	// A timeline's notes can only point into the event log it was read from.
	// ... and it cites nothing: a source that could not be opened has no position to cite an event from.
	if (!value.notes.every((note) => note.refs.length === 0)) return null;
	const window = value.window;
	if (!isPlain(window) || !exactKeys(window, ["afterSequence", "nextAfterSequence", "hasMore"])) return null;
	if (!isCount(window.afterSequence) || !isCount(window.nextAfterSequence)) return null;
	if (window.nextAfterSequence < window.afterSequence) return null;
	// A cursor before a known tail must move: a page that consumes nothing there would send a follower round in a circle.
	if (
		value.source.watermark !== null &&
		window.afterSequence < value.source.watermark.length &&
		window.nextAfterSequence === window.afterSequence
	)
		return null;
	// No reader result spans more positions than the page maximum.
	if (window.nextAfterSequence - window.afterSequence > ENDO_COCKPIT_PAGE_MAX_LIMIT_V0) return null;
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
	// Every position in the window is either presented or an ignored duplicate: nothing is silently missing, so the entries
	// are contiguous apart from the duplicates. (The canonical store refuses a repeated event id on open, so a window read
	// from it has none; the count exists for input that did not come from the store.)
	if (value.entries.length + value.duplicatesIgnored !== window.nextAfterSequence - window.afterSequence) return null;
	// The first position consumed is always presented: a window's duplicate set starts empty, so the first event cannot be
	// a repeat, and an entry that begins later would leave the positions before it unaccounted for.
	if (
		window.nextAfterSequence > window.afterSequence &&
		(value.entries as EndoCockpitTimelineEntryV0[])[0]?.storageSequence !== window.afterSequence + 1
	)
		return null;
	if (value.duplicatesIgnored > 0 && mark !== null && window.nextAfterSequence > mark.length) return null;
	// A window that ends at the end of the log ends at the event the watermark names as the last.
	if (mark !== null && mark.length > 0 && window.nextAfterSequence === mark.length && value.entries.length > 0) {
		const atEnd = (value.entries as EndoCockpitTimelineEntryV0[]).find(
			(entry) => entry.storageSequence === mark.length,
		);
		if (atEnd !== undefined ? atEnd.eventId !== mark.lastEventId : !ids.has(mark.lastEventId as string)) return null;
	}
	const sessions = value.sessions;
	if (
		!arrayOf(
			sessions,
			(item): item is EndoCockpitSessionSummaryV0 =>
				isPlain(item) &&
				exactKeys(item, ["sessionId", "firstStorageSequence", "lastStorageSequence", "entries"]) &&
				typeof item.sessionId === "string" &&
				isPublicId(item.sessionId, "session") &&
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
	let lastAttachment = "";
	// One read is made under one digest key: every source that has a position names the same key.
	const keyIds = new Set<string>();
	const timelineMark = (value.timeline as EndoCockpitSessionTimelineV0).source.watermark;
	if (timelineMark !== null) keyIds.add(timelineMark.keyId);
	for (const runtime of value.runtimes) {
		if (!isPlain(runtime) || !exactKeys(runtime, ["identity", "capabilities"])) return null;
		const identity = validateEndoCockpitRuntimeIdentityV0(runtime.identity);
		const capabilities = validateEndoCockpitCapabilityStateV0(runtime.capabilities);
		if (identity === null || capabilities === null) return null;
		// Both views of one attachment come from one read of its registry: the same condition and the same position.
		if (!sameJson(identity.source, capabilities.source)) return null;
		// Where the two views name one position they name one record.
		if (!positionsKeepIds(identity, capabilities)) return null;
		// ... so they set aside the same fingerprint records, for the same reasons, and the state's latest fingerprint is the
		// identity's current one (neither is derivable from the watermark alone). Other diagnostics are each view's own.
		if (!sameJson(fingerprintCleaning(identity.notes), fingerprintCleaning(capabilities.notes))) return null;
		if (capabilities.state !== null && capabilities.state.latestFingerprintId !== (identity.current?.id ?? null))
			return null;
		if (!evidenceLimitsAgreeWithFingerprint(identity, capabilities)) return null;
		if (identity.source.watermark !== null) keyIds.add(identity.source.watermark.keyId);
		// The records presented by the two views of one registry are distinct records: no two share an id.
		const shown: ({ ref: EndoCockpitRefV0; id: string } | null)[] = [
			identity.current,
			identity.previousDifferent,
			identity.lastChange,
			identity.lastNotification,
			...capabilities.capabilities.map((view) => view.evidence),
		];
		if (!presentedIdsDistinct(shown.filter((view) => view !== null))) return null;
		// One view per attachment, in code-unit order of the attachment name.
		if (seen.size > 0 && !(lastAttachment < identity.source.attachment)) return null;
		lastAttachment = identity.source.attachment;
		seen.add(identity.source.attachment);
	}
	if (keyIds.size > 1) return null;
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
