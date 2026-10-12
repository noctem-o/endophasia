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
// Presentation boundary. Each kind has an allowlist of payload fields (FIELD_SPECS) with the basis of each, read from a
// fixed path and type-checked. Everything else, including every field of a kind that is not listed, is counted in
// `withheldFields` and not copied: tool arguments and results (only their keyed digests are presented), failure text,
// command-line arguments with local paths, recovery paths, and unknown fields. A kind that is not listed is flagged
// "unrecognized" and shown by its envelope alone.

import {
	ENDO_COCKPIT_CATEGORIES_V0,
	ENDO_COCKPIT_FLAGS_V0,
	ENDO_COCKPIT_MAX_PRODUCER_V0,
	ENDO_COCKPIT_PROJECTION_VERSIONS_V0,
	type EndoCockpitCategoryV0,
	type EndoCockpitEventLogSourceV0,
	type EndoCockpitFieldV0,
	type EndoCockpitFlagV0,
	type EndoCockpitNoteV0,
	type EndoCockpitSessionSummaryV0,
	type EndoCockpitSessionTimelineV0,
	type EndoCockpitTimelineEntryV0,
	type EndoCockpitUsageV0,
} from "../../protocol/cockpit.ts";
import type { EndoEventV0 } from "../../protocol/event.ts";
import { isEndoLifecycleKindV0 } from "../../protocol/session-lifecycle.ts";
import { deepFreezeV0 } from "../../runtime/contracts/immutability.ts";

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

type Basis = "observed" | "reported" | "derived";
type FieldType = "string" | "number" | "boolean";
/** [exposed key, payload path, basis, type, null allowed] */
type FieldSpec = readonly [key: string, path: string, basis: Basis, type: FieldType, nullable?: true];

const MAX_STRING = 256;
const MAX_DECLARED_UNAVAILABLE = 32;

const instance: FieldSpec = ["instance", "instance", "observed", "string"];
const runtimeEvent: FieldSpec = ["runtimeEvent", "runtimeEvent", "reported", "string"];
const turns: FieldSpec = ["turns", "turns", "derived", "number"];
const stopReason: FieldSpec = ["stopReason", "stopReason", "reported", "string"];

/** The allowlist per event kind. A kind absent from this table is "unrecognized": the envelope only. */
const FIELD_SPECS: Readonly<Record<string, readonly FieldSpec[]>> = deepFreezeV0({
	"lifecycle.session-started": [
		["runtime", "runtime", "observed", "string"],
		["runtimeSessionId", "runtimeSessionId", "reported", "string"],
		instance,
	],
	"lifecycle.session-resumed": [
		["runtime", "runtime", "observed", "string"],
		["runtimeSessionId", "runtimeSessionId", "reported", "string"],
		instance,
		["previousInstance", "previousInstance", "observed", "string"],
		["previousEnd", "previousEnd", "derived", "string"],
	],
	"lifecycle.run-started": [instance],
	"lifecycle.turn-started": [["turn", "turn", "derived", "number"]],
	"lifecycle.turn-completed": [["turn", "turn", "derived", "number"], stopReason],
	"lifecycle.run-completed": [turns, stopReason],
	"lifecycle.run-failed": [turns],
	"lifecycle.run-aborted": [turns, ["stopRequested", "stopRequested", "derived", "boolean"]],
	"lifecycle.run-unclassified": [turns, ["reason", "reason", "derived", "string"]],
	"lifecycle.stop-requested": [["runOpen", "runOpen", "derived", "boolean"]],
	"lifecycle.stop-accepted": [["runOpen", "runOpen", "derived", "boolean"]],
	"lifecycle.stop-refused": [["runOpen", "runOpen", "derived", "boolean"]],
	"lifecycle.interrupted": [
		["cause", "cause", "derived", "string"],
		instance,
		["runOpen", "runOpen", "derived", "boolean"],
		["turnOpen", "turnOpen", "derived", "boolean"],
		turns,
		["stopRequested", "stopRequested", "derived", "boolean"],
	],
	"lifecycle.detached": [instance, ["expected", "expected", "observed", "boolean"]],
	"lifecycle.compacted": [
		["reason", "reason", "reported", "string"],
		["firstKeptEntryId", "firstKeptEntryId", "reported", "string"],
		["tokensBefore", "tokensBefore", "reported", "number"],
	],
	"lifecycle.anomaly": [
		["observed", "observed", "derived", "string"],
		["problem", "problem", "derived", "string"],
	],
	"lifecycle.unrecognized-runtime-event": [runtimeEvent],
	"control.requested": [
		["action", "action", "observed", "string"],
		["capability", "capability", "observed", "string"],
	],
	"control.accepted": [
		["action", "action", "observed", "string"],
		["capability", "capability", "observed", "string"],
		["disposition", "disposition", "reported", "string"],
	],
	"agent.run-started": [runtimeEvent],
	"agent.run-ended": [runtimeEvent, ["willRetry", "willRetry", "reported", "boolean"]],
	"agent.settled": [runtimeEvent],
	"agent.turn-started": [runtimeEvent],
	"agent.turn-finished": [runtimeEvent, stopReason, ["toolResultCount", "toolResultCount", "reported", "number"]],
	"message.completed": [runtimeEvent, ["role", "role", "reported", "string"], stopReason],
	"tool.started": [
		runtimeEvent,
		["toolCallId", "toolCallId", "reported", "string"],
		["toolName", "toolName", "reported", "string"],
		["argsDigest", "argsDigest.value", "derived", "string"],
		["argsDigestKeyId", "argsDigest.keyId", "derived", "string"],
	],
	"tool.finished": [
		runtimeEvent,
		["toolCallId", "toolCallId", "reported", "string"],
		["toolName", "toolName", "reported", "string"],
		["isError", "isError", "reported", "boolean"],
		["resultDigest", "resultDigest.value", "derived", "string"],
		["resultDigestKeyId", "resultDigest.keyId", "derived", "string"],
	],
	"queue.changed": [
		runtimeEvent,
		["steering", "steering", "reported", "number"],
		["followUp", "followUp", "reported", "number"],
	],
	"compaction.started": [runtimeEvent, ["reason", "reason", "reported", "string"]],
	"compaction.finished": [
		runtimeEvent,
		["reason", "reason", "reported", "string"],
		["aborted", "aborted", "reported", "boolean"],
		["willRetry", "willRetry", "reported", "boolean"],
		["succeeded", "succeeded", "derived", "boolean"],
		["firstKeptEntryId", "firstKeptEntryId", "reported", "string"],
		["tokensBefore", "tokensBefore", "reported", "number"],
	],
	"retry.started": [
		runtimeEvent,
		["attempt", "attempt", "reported", "number"],
		["maxAttempts", "maxAttempts", "reported", "number"],
	],
	"retry.finished": [
		runtimeEvent,
		["attempt", "attempt", "reported", "number"],
		["success", "success", "reported", "boolean"],
	],
	"session.entry-observed": [
		["entryType", "entryType", "reported", "string"],
		["recognized", "recognized", "derived", "boolean"],
		["entryId", "source.entryId", "reported", "string"],
		["parentId", "parentId", "reported", "string", true],
		["role", "details.role", "reported", "string"],
		["stopReason", "details.stopReason", "reported", "string"],
		["tokensBefore", "details.tokensBefore", "reported", "number"],
		["firstKeptEntryId", "details.firstKeptEntryId", "reported", "string"],
	],
	"session.leaf-observed": [["leafId", "leafId", "reported", "string", true]],
	"harness.attached": [
		instance,
		["fingerprintId", "fingerprintId", "observed", "string"],
		["identityDigest", "identityDigest", "derived", "string"],
		["version", "version", "reported", "string", true],
		["runtimeSessionId", "piSessionId", "reported", "string"],
		["mapping", "mapping", "observed", "string"],
	],
	"harness.process-exited": [
		["code", "code", "observed", "number", true],
		["signal", "signal", "observed", "string", true],
		["spawnFailed", "spawnFailed", "observed", "boolean"],
		["expected", "expected", "observed", "boolean"],
	],
	"harness.store-opened": [
		["lifecycleRepaired", "lifecycleRepaired", "observed", "number"],
		["recoveryTruncated", "recovery.truncated", "observed", "boolean"],
		["recoveryRecovered", "recovery.recovered", "observed", "boolean"],
		["recoverySealed", "recovery.sealed", "observed", "boolean"],
	],
	"harness.catch-up": [
		["mode", "mode", "observed", "string"],
		["received", "received", "observed", "number"],
		["added", "added", "observed", "number"],
	],
	"harness.runtime-changed": [
		["previousFingerprintId", "previousFingerprintId", "observed", "string"],
		["currentFingerprintId", "currentFingerprintId", "observed", "string"],
		["previousVersion", "previousVersion", "reported", "string", true],
		["currentVersion", "currentVersion", "reported", "string", true],
	],
	"harness.protocol-fault": [["fault", "fault", "observed", "string"]],
	"harness.session-mismatch": [],
	"runtime.unrecognized-event": [runtimeEvent],
	"runtime.malformed-event": [runtimeEvent],
});

const INTERRUPTION_KINDS: readonly string[] = deepFreezeV0([
	"lifecycle.interrupted",
	"lifecycle.detached",
	"harness.process-exited",
]);
const DISCONTINUITY_KINDS: readonly string[] = deepFreezeV0(["lifecycle.session-resumed", "harness.runtime-changed"]);
const ANOMALY_KINDS: readonly string[] = deepFreezeV0([
	"lifecycle.anomaly",
	"harness.protocol-fault",
	"harness.session-mismatch",
	"runtime.malformed-event",
]);
const UNRECOGNIZED_KINDS: readonly string[] = deepFreezeV0([
	"lifecycle.unrecognized-runtime-event",
	"runtime.unrecognized-event",
]);

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

function scalar(value: unknown, type: FieldType, nullable: boolean): string | number | boolean | null | undefined {
	if (value === null) return nullable ? null : undefined;
	if (type === "string" && typeof value === "string")
		return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
	if (type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
	if (type === "boolean" && typeof value === "boolean") return value;
	return undefined;
}

/** One allowlisted field, or undefined when the payload does not carry it in the expected form. */
function readField(payload: Record<string, unknown>, spec: FieldSpec): EndoCockpitFieldV0 | undefined {
	const [, path, basis, type, nullable] = spec;
	const raw = pathValue(payload, path);
	if (raw === undefined) return undefined;
	// A value the runtime reported, or the reason it did not (protocol/session-lifecycle.ts EndoReportedV0).
	if (isRecord(raw) && raw.status === "reported") {
		const value = scalar(own(raw, "value"), type, false);
		return value === undefined ? undefined : { basis: "reported", value };
	}
	if (isRecord(raw) && raw.status === "UNAVAILABLE") {
		const reason = own(raw, "reason");
		return typeof reason === "string" && reason.length > 0
			? { basis: "unavailable", reason: reason.slice(0, MAX_STRING) }
			: undefined;
	}
	const value = scalar(raw, type, nullable === true);
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
	let whole = list.length <= MAX_DECLARED_UNAVAILABLE;
	for (const item of list.slice(0, MAX_DECLARED_UNAVAILABLE)) {
		const field = isRecord(item) ? own(item, "field") : undefined;
		const reason = isRecord(item) ? own(item, "reason") : undefined;
		if (typeof field !== "string" || field.length === 0 || typeof reason !== "string" || reason.length === 0) {
			whole = false;
			continue;
		}
		fields[`unavailable.${field.slice(0, 100)}`] = { basis: "unavailable", reason: reason.slice(0, MAX_STRING) };
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

/** Kinds that can carry usage: an assistant message, and the durable entries that record a model call. */
function usageOf(event: EndoEventV0, payload: Record<string, unknown>): EndoCockpitTimelineEntryV0["usage"] {
	let carrier: unknown;
	let role: unknown;
	if (event.kind === "message.completed") {
		carrier = own(payload, "usage");
		role = own(payload, "role");
	} else if (event.kind === "session.entry-observed") {
		const entryType = own(payload, "entryType");
		const details = own(payload, "details");
		if (
			entryType !== "message" &&
			entryType !== "compaction" &&
			entryType !== "branch_summary" &&
			entryType !== "usage"
		)
			return null;
		if (!isRecord(details)) return { basis: "unavailable", reason: "the event records no entry details" };
		carrier = own(details, "usage");
		role = entryType === "message" ? own(details, "role") : undefined;
	} else return null;
	if (role === "user") return null;
	if (carrier === undefined) return { basis: "unavailable", reason: "the event records no usage" };
	const usage = readUsage(carrier);
	return usage === undefined
		? { basis: "unavailable", reason: "the recorded usage is not in the expected shape" }
		: { basis: "reported", value: usage };
}

function categoryOf(kind: string): EndoCockpitCategoryV0 {
	const segment = kind.slice(0, kind.indexOf("."));
	return (ENDO_COCKPIT_CATEGORIES_V0 as readonly string[]).includes(segment)
		? (segment as EndoCockpitCategoryV0)
		: "other";
}

function flagsOf(event: EndoEventV0, payload: Record<string, unknown>, listed: boolean): EndoCockpitFlagV0[] {
	const flags = new Set<EndoCockpitFlagV0>();
	if (INTERRUPTION_KINDS.includes(event.kind)) flags.add("interruption");
	if (DISCONTINUITY_KINDS.includes(event.kind)) flags.add("discontinuity");
	if (event.kind === "harness.store-opened") {
		const recovery = own(payload, "recovery");
		if (
			isRecord(recovery) &&
			(recovery.truncated === true || recovery.recovered === true || recovery.sealed === true)
		)
			flags.add("discontinuity");
	}
	if (ANOMALY_KINDS.includes(event.kind)) flags.add("anomaly");
	if (
		UNRECOGNIZED_KINDS.includes(event.kind) ||
		!listed ||
		(event.kind.startsWith("lifecycle.") && !isEndoLifecycleKindV0(event.kind))
	)
		flags.add("unrecognized");
	return ENDO_COCKPIT_FLAGS_V0.filter((flag) => flags.has(flag));
}

function entryOf(stored: EndoCockpitStoredEventV0): EndoCockpitTimelineEntryV0 {
	const { event, storageSequence } = stored;
	const payload = isRecord(event.payload) ? event.payload : {};
	const specs = Object.hasOwn(FIELD_SPECS, event.kind) ? FIELD_SPECS[event.kind]! : null;
	const fields: Record<string, EndoCockpitFieldV0> = {};
	const presentedWhole = new Set<string>();
	for (const spec of specs ?? []) {
		const field = readField(payload, spec);
		if (field === undefined) continue;
		fields[spec[0]] = field;
		// A key counts as presented only when the whole top-level value is shown; a nested path leaves the rest withheld.
		if (!spec[1].includes(".")) presentedWhole.add(spec[1]);
	}
	if (event.kind === "lifecycle.session-started" || event.kind === "lifecycle.session-resumed") {
		const declared = declaredUnavailable(payload);
		Object.assign(fields, declared.fields);
		if (declared.whole) presentedWhole.add("unavailable");
	}
	const keys = isRecord(event.payload) ? Object.keys(event.payload) : [];
	return {
		storageSequence,
		eventId: event.id,
		kind: event.kind,
		category: categoryOf(event.kind),
		source: event.source,
		producer:
			event.producer.length > ENDO_COCKPIT_MAX_PRODUCER_V0
				? event.producer.slice(0, ENDO_COCKPIT_MAX_PRODUCER_V0)
				: event.producer,
		producerSequence: event.sequence,
		recordedAt: event.at,
		sessionId: event.coordinates.sessionId ?? null,
		runId: event.coordinates.runId ?? null,
		experimentId: event.coordinates.experimentId ?? null,
		derivedFrom: [...event.derivedFrom],
		flags: flagsOf(event, payload, specs !== null),
		fields,
		usage: usageOf(event, payload),
		withheldFields: keys.filter((key) => !presentedWhole.has(key)).length + (isRecord(event.payload) ? 0 : 1),
	};
}

/**
 * The timeline projection of one window of the event log. Throws a TypeError when the input breaks its own contract: a
 * storage sequence at or below the window's lower bound, or not strictly ascending. (A store cannot produce either.)
 */
export function projectEndoCockpitSessionTimelineV0(input: EndoCockpitTimelineInputV0): EndoCockpitSessionTimelineV0 {
	const { source, afterSequence, events } = input;
	if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
		throw new TypeError("the window's afterSequence must be a non-negative integer");
	const entries: EndoCockpitTimelineEntryV0[] = [];
	const sessions = new Map<string, EndoCockpitSessionSummaryV0>();
	const seen = new Set<string>();
	const notes: EndoCockpitNoteV0[] = [];
	let duplicatesIgnored = 0;
	let previous = afterSequence;
	for (const stored of events) {
		if (!Number.isSafeInteger(stored.storageSequence) || stored.storageSequence <= previous)
			throw new TypeError("storage sequences must be strictly ascending and above the window's afterSequence");
		previous = stored.storageSequence;
		if (seen.has(stored.event.id)) {
			duplicatesIgnored += 1;
			continue;
		}
		seen.add(stored.event.id);
		const entry = entryOf(stored);
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
