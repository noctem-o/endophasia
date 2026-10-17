// The session timeline projection: a bounded window of the durable event log, in storage order, as presentation data.
// Pure and deterministic: the same window and projection version give the same canonical output.
//
// Ordering. The only order is the event log's storage sequence (1-based append order), which the caller passes with
// each event: the projection never infers it from array position, a producer's `sequence`, or `at`. Producer sequences
// are monotonic within one producer's stream only and `at` is the producer's clock; both are shown, neither orders.
//
// Nothing is synthesized. A run id, turn id, completion claim or outcome appears only if the event's coordinates or
// payload carry it; lifecycle `turn` and `turns` are the observer's counts (basis derived), not the runtime's.
//
// Presentation boundary. Two separate questions, two tables:
//  - Is the kind RECOGNISED? RECOGNIZED_KINDS names every kind the repository's producers record in the durable event log
//    (the Pi and ACP adapters, the lifecycle and intervention vocabularies), as plain strings: the projection imports no
//    adapter. A kind outside it is flagged "unrecognized".
//  - Which payload fields may be PRESENTED? ENDO_COCKPIT_FIELD_SPECS_V0 is an allowlist per kind, with the basis of each field, read from a
//    fixed path and type-checked. A recognised kind with no entry shows its envelope only.
// Everything not allowlisted is counted in `withheldFields` and not copied: tool arguments and results (only their keyed
// digests are presented), failure text, command-line arguments with local paths, recovery paths, permission and
// configuration contents, and unknown fields.

import {
	ENDO_COCKPIT_FLAGS_V0,
	ENDO_COCKPIT_PROJECTION_VERSIONS_V0,
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	type EndoCockpitEventLogSourceV0,
	type EndoCockpitFieldV0,
	type EndoCockpitFlagV0,
	type EndoCockpitNoteV0,
	type EndoCockpitSessionSummaryV0,
	type EndoCockpitSessionTimelineV0,
	type EndoCockpitTimelineEntryV0,
	type EndoCockpitUsageV0,
	endoCockpitCategoryOfV0,
	validateEndoCockpitSessionTimelineV0,
} from "../../protocol/cockpit.ts";
import {
	ENDO_COCKPIT_ANOMALY_KINDS_V0,
	ENDO_COCKPIT_DISCONTINUITY_KINDS_V0,
	ENDO_COCKPIT_FIELD_SPECS_V0,
	ENDO_COCKPIT_INTERRUPTION_KINDS_V0,
	ENDO_COCKPIT_KEYED_DIGEST_FIELDS_V0,
	ENDO_COCKPIT_MAX_DECLARED_UNAVAILABLE_V0,
	ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0,
	ENDO_COCKPIT_UNRECOGNIZED_KINDS_V0,
	ENDO_COCKPIT_USAGE_REASONS_V0,
	type EndoCockpitFieldSpecV0,
	type EndoCockpitFieldTypeV0,
	endoCockpitFieldRuleV0,
	endoCockpitGapNameAdmittedV0,
	endoCockpitKindRecognizedV0,
	endoCockpitProducerAdmittedV0,
	endoCockpitRuntimeSessionAdmittedV0,
	endoCockpitTextPresentableV0,
	isEndoCockpitSourceKindAdmittedV0,
} from "../../protocol/cockpit-fields.ts";
import type { EndoEventV0 } from "../../protocol/event.ts";
import { parseEndoIdentifierV0 } from "../../protocol/identity.ts";
import { isEndoKeyedDigestV0 } from "../../protocol/keyed-digest-shape.ts";
import { isEndoLifecycleKindV0 } from "../../protocol/session-lifecycle.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { cockpitAliasesV0, type EndoCockpitAliasesV0 } from "./common.ts";

/** One event of the log with the storage sequence it was read at. */
export interface EndoCockpitStoredEventV0 {
	storageSequence: number;
	event: EndoEventV0;
}

/** Input of the timeline projection: the source's position, the window's lower bound, and the window's events. */
export interface EndoCockpitTimelineInputV0 {
	source: EndoCockpitEventLogSourceV0;
	/** The cursor the window was read after: every event has a storage sequence greater than this. */
	afterSequence: number;
	events: readonly EndoCockpitStoredEventV0[];
}

const MAX_STRING = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function pathValue(payload: Record<string, unknown>, path: string): unknown {
	let current: unknown = payload;
	for (const segment of path.split(".")) {
		if (!isRecord(current)) return undefined;
		current = own(current, segment);
		if (current === undefined) return undefined;
	}
	return current;
}

function scalar(
	alias: EndoCockpitAliasesV0,
	value: unknown,
	type: EndoCockpitFieldTypeV0,
	nullable: boolean,
): string | number | boolean | null | undefined {
	if (value === null) return nullable ? null : undefined;
	if (type === "string" && typeof value === "string") return value;
	if (type === "id" && typeof value === "string")
		return parseEndoIdentifierV0(value) === null ? undefined : alias.id(value);
	if (type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
	if (type === "boolean" && typeof value === "boolean") return value;
	return undefined;
}

/**
 * A reason or field text the runtime or adapter wrote. Judged whole and never cut (a cut can split a secret so that
 * neither half is recognised): presented as it is when it is non-empty, within the bound and not unsafe, else null.
 */
function freeText(text: string): string | null {
	return endoCockpitTextPresentableV0(text, MAX_STRING) ? text : null;
}

/** A fresh object each time: results are plain data, and no two of them may share one. */
const withheldField = (): EndoCockpitFieldV0 => ({ basis: "unavailable", reason: ENDO_COCKPIT_WITHHELD_TEXT_V0 });
const isWithheld = (field: EndoCockpitFieldV0): boolean =>
	field.basis === "unavailable" && field.reason === ENDO_COCKPIT_WITHHELD_TEXT_V0;

/**
 * One allowlisted field, or undefined when the payload does not carry it in the expected form. A string that looks like it
 * embeds a path, address or credential is presented as the fixed withheld text instead (withheldField()).
 */
function readField(
	alias: EndoCockpitAliasesV0,
	kind: string,
	payload: Record<string, unknown>,
	spec: EndoCockpitFieldSpecV0,
): EndoCockpitFieldV0 | undefined {
	const [, path, basis, type, nullable] = spec;
	const raw = pathValue(payload, path);
	if (raw === undefined) return undefined;
	// A member of a keyed digest is shown only when the whole digest object is a well-formed one.
	const digest = Object.hasOwn(ENDO_COCKPIT_KEYED_DIGEST_FIELDS_V0, spec[0])
		? ENDO_COCKPIT_KEYED_DIGEST_FIELDS_V0[spec[0]]
		: undefined;
	if (digest !== undefined && !isEndoKeyedDigestV0(own(payload, digest.parent))) return undefined;
	// A field of an opaque value is shown only in the shape the policy admits for it; any other is withheld whole.
	const admitted = endoCockpitFieldRuleV0(kind, spec[0])?.admitted;
	const judged = (text: string): boolean => freeText(text) !== null && (admitted === undefined || admitted(text));
	// A value the runtime reported, or the reason it did not (protocol/session-lifecycle.ts EndoReportedV0). Only a field
	// whose basis IS "reported" can arrive in that wrapper: a wrapper around an observed or derived field is malformed and
	// is omitted (so counted as withheld), never allowed to change what the field claims to be.
	const wrapped = basis === "reported";
	if (wrapped && isRecord(raw) && raw.status === "reported") {
		const value = scalar(alias, own(raw, "value"), type, false);
		if (typeof value === "string" && !judged(value)) return withheldField();
		return value === undefined ? undefined : { basis: "reported", value };
	}
	if (wrapped && isRecord(raw) && raw.status === "UNAVAILABLE") {
		const reason = own(raw, "reason");
		return typeof reason === "string" && reason.length > 0
			? { basis: "unavailable", reason: freeText(reason) ?? ENDO_COCKPIT_WITHHELD_TEXT_V0 }
			: undefined;
	}
	// The runtime identity digest commits to withheld facts (the real path): shown only as its keyed token, never as recorded.
	if (spec[0] === "identityDigest") {
		if (typeof raw !== "string") return undefined;
		return /^[0-9a-f]{64}$/.test(raw) ? { basis, value: alias.digest("identity", raw) } : withheldField();
	}
	const value = scalar(alias, raw, type, nullable === true);
	if (typeof value === "string" && !judged(value)) return withheldField();
	return value === undefined ? undefined : { basis, value };
}

/**
 * What the runtime does not report, as the adapter declared it on a session start (`unavailable: [{ field, reason }]`):
 * each becomes an "unavailable" field, so a missing run id stays a stated gap. `whole` is false when an item was not
 * in that shape, and the array then counts as withheld.
 */
function declaredUnavailable(payload: Record<string, unknown>): {
	fields: Record<string, EndoCockpitFieldV0>;
	whole: boolean;
} {
	const fields: Record<string, EndoCockpitFieldV0> = {};
	const list = own(payload, "unavailable");
	if (list === undefined) return { fields, whole: false };
	if (!Array.isArray(list)) return { fields, whole: false };
	let whole = list.length <= ENDO_COCKPIT_MAX_DECLARED_UNAVAILABLE_V0;
	for (const item of list.slice(0, ENDO_COCKPIT_MAX_DECLARED_UNAVAILABLE_V0)) {
		const field = isRecord(item) ? own(item, "field") : undefined;
		const reason = isRecord(item) ? own(item, "reason") : undefined;
		if (typeof field !== "string" || field.length === 0 || typeof reason !== "string" || reason.length === 0) {
			whole = false;
			continue;
		}
		// A member beside `field` and `reason` is not shown, so the item is not presented whole.
		if (Object.keys(item as object).length !== 2) whole = false;
		if (!endoCockpitGapNameAdmittedV0(field)) {
			whole = false;
			continue;
		}
		const shown = freeText(reason);
		if (shown === null) whole = false;
		// A name declared twice keeps its last item (as it always has), and the array is then not shown whole.
		if (Object.hasOwn(fields, `unavailable.${field}`)) whole = false;
		fields[`unavailable.${field}`] = {
			basis: "unavailable",
			reason: shown ?? ENDO_COCKPIT_WITHHELD_TEXT_V0,
		};
	}
	return { fields, whole };
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsage(value: unknown): EndoCockpitUsageV0 | undefined {
	if (!isRecord(value)) return undefined;
	const input = finite(own(value, "input"));
	const output = finite(own(value, "output"));
	const cacheRead = finite(own(value, "cacheRead"));
	const cacheWrite = finite(own(value, "cacheWrite"));
	const totalTokens = finite(own(value, "totalTokens"));
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined)
		return undefined;
	if (totalTokens === undefined) return undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		costTotal: finite(own(value, "costTotal")) ?? null,
		reasoning: finite(own(value, "reasoning")) ?? null,
	};
}

/** The string a presented field carries, or undefined when the entry presents none (absent, unavailable or withheld). */
function presentedString(fields: Record<string, EndoCockpitFieldV0>, key: string): string | undefined {
	const field = fields[key];
	return field !== undefined && field.basis !== "unavailable" && typeof field.value === "string"
		? field.value
		: undefined;
}

const USAGE_ENTRY_TYPES: readonly string[] = ["message", "compaction", "branch_summary", "usage"];

/**
 * Kinds that can carry usage: an assistant (any non-user) message, and the durable entries that record a model call
 * (except a user message). Decided from the fields the entry PRESENTS, the same ones the validator reads
 * (protocol/cockpit.ts usageEligible), so the two cannot disagree: a wrapped or withheld value is judged as presented.
 */
function usageOf(
	event: EndoEventV0,
	payload: Record<string, unknown>,
	fields: Record<string, EndoCockpitFieldV0>,
): EndoCockpitTimelineEntryV0["usage"] {
	let carrier: unknown;
	if (event.kind === "message.completed") {
		if (presentedString(fields, "role") === "user") return null;
		carrier = own(payload, "usage");
	} else if (event.kind === "session.entry-observed") {
		const entryType = presentedString(fields, "entryType");
		if (entryType === undefined || !USAGE_ENTRY_TYPES.includes(entryType)) return null;
		const details = own(payload, "details");
		if (!isRecord(details)) return { basis: "unavailable", reason: ENDO_COCKPIT_USAGE_REASONS_V0[0]! };
		if (entryType === "message" && presentedString(fields, "role") === "user") return null;
		carrier = own(details, "usage");
	} else return null;
	if (carrier === undefined) return { basis: "unavailable", reason: ENDO_COCKPIT_USAGE_REASONS_V0[1]! };
	const usage = readUsage(carrier);
	return usage === undefined
		? { basis: "unavailable", reason: ENDO_COCKPIT_USAGE_REASONS_V0[2]! }
		: { basis: "reported", value: usage };
}

const categoryOf = endoCockpitCategoryOfV0;

function flagsOf(event: EndoEventV0, payload: Record<string, unknown>, recognized: boolean): EndoCockpitFlagV0[] {
	const flags = new Set<EndoCockpitFlagV0>();
	if (ENDO_COCKPIT_INTERRUPTION_KINDS_V0.includes(event.kind)) flags.add("interruption");
	if (ENDO_COCKPIT_DISCONTINUITY_KINDS_V0.includes(event.kind)) flags.add("discontinuity");
	if (event.kind === "harness.store-opened") {
		const recovery = own(payload, "recovery");
		if (
			isRecord(recovery) &&
			(recovery.truncated === true || recovery.recovered === true || recovery.sealed === true)
		)
			flags.add("discontinuity");
	}
	if (ENDO_COCKPIT_ANOMALY_KINDS_V0.includes(event.kind)) flags.add("anomaly");
	if (event.kind === "harness.attached" && runtimeSessionOf(payload).conflict) flags.add("anomaly");
	if (
		ENDO_COCKPIT_UNRECOGNIZED_KINDS_V0.includes(event.kind) ||
		!recognized ||
		(event.kind.startsWith("lifecycle.") && !isEndoLifecycleKindV0(event.kind))
	)
		flags.add("unrecognized");
	return ENDO_COCKPIT_FLAGS_V0.filter((flag) => flags.has(flag));
}

/**
 * The runtime session reference a `harness.attached` event records, under either producer's name for it: Pi's
 * `piSessionId`, ACP v1 and v2's `acpSessionId` (already the id itself or a digest of it, as the recorder wrote it).
 * Never invented: no field, no presentation. If both are recorded and differ, neither is chosen.
 */
function runtimeSessionOf(payload: Record<string, unknown>): {
	field: EndoCockpitFieldV0 | undefined;
	keys: string[];
	conflict: boolean;
} {
	const found: { key: string; value: string }[] = [];
	for (const key of ["piSessionId", "acpSessionId"]) {
		const value = own(payload, key);
		if (typeof value === "string" && value.length > 0) found.push({ key, value });
	}
	if (found.length === 2 && found[0]!.value !== found[1]!.value)
		return {
			field: { basis: "unavailable", reason: ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0 },
			keys: [],
			conflict: true,
		};
	const first = found[0];
	// The reference is the runtime's own opaque string: it is presented only in a form Endophasia itself writes or a
	// plain identifier shape (ADMITTED_RUNTIME_SESSION), never on the strength of a content filter.
	if (first !== undefined && !endoCockpitRuntimeSessionAdmittedV0(first.value))
		return { field: withheldField(), keys: [], conflict: false };
	return {
		field: first && { basis: "reported", value: first.value },
		keys: found.map((item) => item.key),
		conflict: false,
	};
}

const USAGE_KEYS: readonly string[] = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"totalTokens",
	"costTotal",
	"reasoning",
];

/** The usage object is presented whole only when every key it carries is one the contract presents, as a finite number. */
function usageIsWhole(payload: Record<string, unknown>): boolean {
	const usage = own(payload, "usage");
	return (
		isRecord(usage) &&
		readUsage(usage) !== undefined &&
		Object.entries(usage).every(([key, value]) => USAGE_KEYS.includes(key) && finite(value) !== undefined)
	);
}

/** A reported or unavailable wrapper is exactly `{ status, value }` or `{ status, reason }`; a member beside them is not shown. */
function wrapperIsExact(raw: unknown): boolean {
	if (!isRecord(raw) || (raw.status !== "reported" && raw.status !== "UNAVAILABLE")) return true;
	const keys = Object.keys(raw);
	return keys.length === 2 && keys.includes(raw.status === "reported" ? "value" : "reason");
}

function entryOf(alias: EndoCockpitAliasesV0, stored: EndoCockpitStoredEventV0): EndoCockpitTimelineEntryV0 {
	const { event, storageSequence } = stored;
	const payload = isRecord(event.payload) ? event.payload : {};
	const specs = Object.hasOwn(ENDO_COCKPIT_FIELD_SPECS_V0, event.kind)
		? ENDO_COCKPIT_FIELD_SPECS_V0[event.kind]!
		: null;
	const fields: Record<string, EndoCockpitFieldV0> = {};
	const presentedWhole = new Set<string>();
	for (const spec of specs ?? []) {
		const field = readField(alias, event.kind, payload, spec);
		if (field === undefined) continue;
		fields[spec[0]] = field;
		// A key counts as presented only when the whole top-level value is shown; a nested path leaves the rest withheld,
		// and so does a value the boundary replaced.
		if (!spec[1].includes(".") && !isWithheld(field) && wrapperIsExact(pathValue(payload, spec[1])))
			presentedWhole.add(spec[1]);
	}
	if (event.kind === "lifecycle.session-started" || event.kind === "lifecycle.session-resumed") {
		const declared = declaredUnavailable(payload);
		Object.assign(fields, declared.fields);
		if (declared.whole) presentedWhole.add("unavailable");
	}
	if (event.kind === "harness.attached") {
		const session = runtimeSessionOf(payload);
		if (session.field !== undefined) fields.runtimeSessionId = session.field;
		for (const key of session.keys) presentedWhole.add(key);
	}
	const usage = usageOf(event, payload, fields);
	// The usage key is presented whole only when the entry carries the complete reported value (an ineligible role shows none).
	if (event.kind === "message.completed" && usage?.basis === "reported" && usageIsWhole(payload))
		presentedWhole.add("usage");
	// A kind is grammar-valid whatever it says: one the text policy flags is presented as a placeholder in "other".
	const presentedKind = !isEndoCockpitSourceKindAdmittedV0(event.kind)
		? `other.${alias.kind(event.kind)}`
		: event.kind;
	const keys = isRecord(event.payload) ? Object.keys(event.payload) : [];
	return {
		storageSequence,
		eventId: alias.id(event.id),
		kind: presentedKind,
		category: categoryOf(presentedKind),
		source: event.source,
		producer: endoCockpitProducerAdmittedV0(event.producer) ? event.producer : ENDO_COCKPIT_WITHHELD_TEXT_V0,
		producerSequence: event.sequence,
		recordedAt: event.at,
		sessionId: event.coordinates.sessionId === undefined ? null : alias.id(event.coordinates.sessionId),
		runId: event.coordinates.runId === undefined ? null : alias.id(event.coordinates.runId),
		experimentId: event.coordinates.experimentId === undefined ? null : alias.id(event.coordinates.experimentId),
		derivedFrom: event.derivedFrom.map((id) => alias.id(id)),
		flags: flagsOf(event, payload, endoCockpitKindRecognizedV0(event.kind)),
		fields,
		usage,
		withheldFields: keys.filter((key) => !presentedWhole.has(key)).length + (isRecord(event.payload) ? 0 : 1),
	};
}

/**
 * The timeline projection of one window of the event log. Throws a TypeError when the input breaks its own contract: a
 * storage sequence that is not the previous position plus one, beginning at `afterSequence + 1`: every consumed position
 * is an event of the window or a duplicate it ignored, so the result accounts for them all. (A store reads contiguously.)
 * Every supplied position must also lie within the source's declared length, and a source with no watermark supplies no
 * events. The input is trusted for nothing else: the projector reads no file and verifies no source.
 */
function projectEndoCockpitSessionTimelineUncheckedV0(
	input: EndoCockpitTimelineInputV0,
	digestKey: EndoDigestKeyV0,
): EndoCockpitSessionTimelineV0 {
	const { source, afterSequence, events } = input;
	if (source.watermark !== null && source.watermark.keyId !== digestKey.keyId)
		throw new TypeError("the digest key is not the key the source was read under");
	const alias = cockpitAliasesV0(digestKey);
	if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
		throw new TypeError("the window's afterSequence must be a non-negative integer");
	const entries: EndoCockpitTimelineEntryV0[] = [];
	const sessions = new Map<string, EndoCockpitSessionSummaryV0>();
	const seen = new Set<string>();
	const notes: EndoCockpitNoteV0[] = [];
	let duplicatesIgnored = 0;
	let previous = afterSequence;
	for (const stored of events) {
		if (!Number.isSafeInteger(stored.storageSequence) || stored.storageSequence !== previous + 1)
			throw new TypeError("storage sequences must be contiguous, beginning right after the window's afterSequence");
		// No event lies beyond the source's declared position, and a source with none (unopenable) supplies no events.
		if (source.watermark === null || stored.storageSequence > source.watermark.length)
			throw new TypeError("an event lies beyond the source's declared length");
		// The event at the source's last position is the one its watermark names (a duplicate's id is already in the window).
		if (
			stored.storageSequence === source.watermark.length &&
			alias.id(stored.event.id) !== source.watermark.lastEventId
		)
			throw new TypeError("the event at the source's last position is not the one its watermark names");
		previous = stored.storageSequence;
		if (seen.has(stored.event.id)) {
			duplicatesIgnored += 1;
			continue;
		}
		seen.add(stored.event.id);
		const entry = entryOf(alias, stored);
		entries.push(entry);
		if (entry.sessionId !== null) {
			const summary = sessions.get(entry.sessionId);
			if (summary === undefined)
				sessions.set(entry.sessionId, {
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
	}
	const nextAfterSequence = previous;
	// A cursor before the declared tail that consumes nothing cannot be followed to the end: refuse it, do not invent progress.
	if (source.watermark !== null && afterSequence < source.watermark.length && nextAfterSequence === afterSequence)
		throw new TypeError("the window consumes no event although the source holds events after its cursor");
	if (source.condition.state === "unopenable") notes.push({ code: "source-not-projectable", refs: [] });
	return {
		schemaVersion: "endo.cockpit-session-timeline.v0",
		projectionVersion: ENDO_COCKPIT_PROJECTION_VERSIONS_V0.sessionTimeline,
		source,
		order: "storage-ascending",
		window: {
			afterSequence,
			nextAfterSequence,
			hasMore: source.watermark === null ? null : source.watermark.length > nextAfterSequence,
		},
		entries,
		sessions: [...sessions.values()],
		duplicatesIgnored,
		notes,
	};
}

/**
 * The timeline projection of one window of the event log. Throws a TypeError when the input breaks its own contract (see
 * above) or when the result would not satisfy the timeline contract, so a value that fails its validator is never returned.
 */
export function projectEndoCockpitSessionTimelineV0(
	input: EndoCockpitTimelineInputV0,
	digestKey: EndoDigestKeyV0,
): EndoCockpitSessionTimelineV0 {
	const result = projectEndoCockpitSessionTimelineUncheckedV0(input, digestKey);
	if (validateEndoCockpitSessionTimelineV0(result) === null)
		throw new TypeError("the events do not agree with the source they were read from");
	return result;
}
