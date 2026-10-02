// The Endo object v0 schema: the versioned, language-neutral object envelope for cognition-graph nodes. The
// normalized object store, traversal, and subscriptions are later phases; this is the wire shape and the identity.

import { type EndoIdentifierKindV0, isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import type { JsonValueV0 } from "./primitives.ts";

/**
 * An object observed by Endophasia: a typed node of the cognition graph. The `payload` shape is kind-specific and is
 * defined by the observation that created the object, never by the store.
 */
export interface EndoObjectV0 {
	schemaVersion: "endo.object.v0";
	/** A stable identifier (`endo.node.*`). */
	id: string;
	/** A dotted object type, e.g. `claim`, `hypothesis`. */
	kind: string;
	/** A strict JSON payload; its shape is kind-specific. */
	payload: JsonValueV0;
	/** The identifier of the event that observed this object (`endo.event.*`). */
	observedIn: string;
}

function isStrictJsonValue(value: unknown): value is JsonValueV0 {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isStrictJsonValue);
	if (typeof value === "object") return Object.entries(value).every(([, entry]) => isStrictJsonValue(entry));
	return false;
}

function isEndoIdentifier(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, kind);
}

const ENDO_OBJECT_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "kind", "payload", "observedIn"]);

/**
 * Validates an object envelope. Rejects unknown fields (strict-JSON discipline), identifiers in the wrong namespace,
 * malformed kinds, and non-strict-JSON payloads. Returns the validated value unchanged, or null.
 */
export function validateEndoObjectV0(value: unknown): EndoObjectV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_OBJECT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.object.v0") return null;
	if (!isEndoIdentifier(v.id, "node")) return null;
	if (typeof v.kind !== "string" || !isWellFormedKindV0(v.kind)) return null;
	if (!isStrictJsonValue(v.payload)) return null;
	if (!isEndoIdentifier(v.observedIn, "event")) return null;
	return value as EndoObjectV0;
}
