// The Endo event v0 schema: the versioned, language-neutral event envelope. Everything important is observable as a
// structured event (README "Event model"); the envelope is the contract, and kind-specific payloads are strict JSON
// whose shape the emitting kind defines and the consuming side validates. Not every runtime emits every event; a
// missing capability stays represented as missing, never filled in.

import { type EndoIdentifierKindV0, isEndoIdentifierV0, isWellFormedEventKindV0 } from "./identity.ts";
import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";

/**
 * What an event is. The six classes are not interchangeable (README): a runtime fact is never silently upgraded to
 * an interpretation, and an interpretation is never presented as a fact it derived from.
 */
export type EndoEventSourceV0 =
	| "runtime-fact"
	| "interpretation"
	| "hypothesis"
	| "evaluation-result"
	| "policy-conclusion"
	| "authority-decision";

/** The closed v0 source classes, machine-checkable. */
export const ENDO_EVENT_SOURCES_V0 = [
	"runtime-fact",
	"interpretation",
	"hypothesis",
	"evaluation-result",
	"policy-conclusion",
	"authority-decision",
] as const satisfies readonly EndoEventSourceV0[];

/**
 * The lifetime and experiment an event belongs to. Every part is optional: some events belong to none of them (for
 * example, creating an experiment is not inside an experiment).
 */
export interface EndoEventCoordinatesV0 {
	/** `endo.session.*` */
	sessionId?: string;
	/** `endo.run.*` */
	runId?: string;
	/** `endo.experiment.*` */
	experimentId?: string;
}

/** A structured event. */
export interface EndoEventV0 {
	schemaVersion: "endo.event.v0";
	/** A stable identifier (`endo.event.*`). */
	id: string;
	/** A dotted event type, e.g. `session.started`, `tool.completed`. */
	kind: string;
	/** The class of what this event is. */
	source: EndoEventSourceV0;
	/**
	 * Monotonic within the emitting stream. Consumers MUST NOT compare sequences across streams (the same invariant
	 * as the mission-trace v0 `sequence`).
	 */
	sequence: number;
	/** The wall-clock emission time, ISO-8601 UTC, e.g. `2026-10-02T11:00:00Z`. */
	at: string;
	/** The lifetimes and experiment this event belongs to. */
	coordinates: EndoEventCoordinatesV0;
	/**
	 * The emitting identity: an `endo.*` identifier, or an opaque non-empty string for an emitter that has no Endo
	 * identity (e.g. a runtime worker).
	 */
	producer: string;
	/** The identifiers of the events this event interprets or derives from; `[]` for a directly emitted event. */
	derivedFrom: string[];
	/** A strict JSON payload; its shape is kind-specific and defined by the emitting kind. */
	payload: JsonValueV0;
}

function isStrictJsonValue(value: unknown): value is JsonValueV0 {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isStrictJsonValue);
	if (typeof value === "object" && isPlainJsonObjectV0(value))
		return Object.entries(value).every(([, entry]) => isStrictJsonValue(entry));
	return false;
}

function isEndoIdentifier(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, kind);
}

const ENDO_EVENT_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"kind",
	"source",
	"sequence",
	"at",
	"coordinates",
	"producer",
	"derivedFrom",
	"payload",
]);

/**
 * Validates an event envelope. Rejects unknown fields (strict-JSON discipline), malformed identifiers, unknown
 * source classes, non-integer sequences, and non-strict-JSON payloads. Returns the validated value unchanged, or
 * null.
 */
export function validateEndoEventV0(value: unknown): EndoEventV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_EVENT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.event.v0") return null;
	if (!isEndoIdentifier(v.id, "event")) return null;
	if (typeof v.kind !== "string" || !isWellFormedEventKindV0(v.kind)) return null;
	if (typeof v.source !== "string" || !(ENDO_EVENT_SOURCES_V0 as readonly string[]).includes(v.source)) return null;
	if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 0) return null;
	if (typeof v.at !== "string" || v.at.length === 0) return null;
	const c = v.coordinates;
	if (typeof c !== "object" || c === null || !isPlainJsonObjectV0(c)) return null;
	const coords = c as Record<string, unknown>;
	for (const key of Object.keys(coords)) {
		if (key !== "sessionId" && key !== "runId" && key !== "experimentId") return null;
	}
	if (coords.sessionId !== undefined && !isEndoIdentifier(coords.sessionId, "session")) return null;
	if (coords.runId !== undefined && !isEndoIdentifier(coords.runId, "run")) return null;
	if (coords.experimentId !== undefined && !isEndoIdentifier(coords.experimentId, "experiment")) return null;
	if (typeof v.producer !== "string" || v.producer.length === 0) return null;
	if (!Array.isArray(v.derivedFrom) || !v.derivedFrom.every((id) => isEndoIdentifier(id, "event"))) return null;
	if (!isStrictJsonValue(v.payload)) return null;
	return value as EndoEventV0;
}
