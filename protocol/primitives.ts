// Neutral v0 primitives shared by the Endophasia protocol schemas. Some redefine, with an identical wire shape, a
// small vocabulary that a concrete runtime also reports; others are protocol-level shapes no runtime owns. The
// protocol never imports a concrete runtime.

/** A lane's in-flight operation status; identical literals to Pi's `OperationStatus`. */
export type OperationStatusV0 = "running" | "open" | "aborting";

/** A lane's configured thinking level; identical literals to Pi's `ThinkingLevel`. */
export type ThinkingLevelV0 = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A lane's configured model identity; identical shape to Pi's `ModelIdentity`. */
export interface ModelIdentityV0 {
	provider: string;
	modelId: string;
}

/** A strict JSON value: the wire shape every protocol payload carries. */
export type JsonValueV0 = null | boolean | number | string | JsonValueV0[] | { [key: string]: JsonValueV0 };

/**
 * Whether a value is a plain JSON object: an object that is not an array, not null, and whose prototype is
 * `Object.prototype` or null (as with `Object.create(null)`). A class instance — even one whose own properties
 * exactly match a record shape — is not a plain object; no protocol validator accepts one.
 */
export function isPlainJsonObjectV0(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}
