// Version-directed reading of a self-describing durable record.
//
// A record that declares `schemaVersion` is decoded by exactly the validator registered for that version, never by
// whichever validator happens to accept it:
//
//   parse the declared version → look it up directly → validate strictly under that one version → the record, or a failure
//
// The helper neither migrates nor defaults: the value it returns is the value it was given. Four failures stay
// distinguishable, because a caller (and a test) must tell them apart: the input is not a plain JSON object, it
// declares no `schemaVersion`, the declared version is not a string, the version is unknown to this reader (rejected
// before any validator runs), and the version is known but the record does not satisfy it. Reading and migration are
// different operations; this is only reading. Canonical serialization is a separate guarantee and not checked here.
//
// A family owns its table, next to its validators. There is deliberately no registry of every family.

import { isPlainJsonObjectV0 } from "./primitives.ts";

/** A validator for one exact schema version: the value unchanged, or null. It may throw `EndoInvalidRecordV0` to say why. */
export type EndoVersionValidatorV0<T> = (value: unknown) => T | null;

/** The versions a family reads, each with its own validator. Frozen and closed; versions are looked up with `validatorFor`, never by property. */
export interface EndoVersionTableV0<T> {
	readonly family: string;
	/** The versions this reader knows, in declaration order. */
	readonly versions: readonly string[];
	/** The validator registered for exactly this version, or undefined. The underlying map is not exposed. */
	validatorFor(version: string): EndoVersionValidatorV0<T> | undefined;
}

export type EndoVersionFailureKindV0 =
	| "not-an-object"
	| "missing-version"
	| "version-not-string"
	| "unsupported-version"
	| "invalid";

export type EndoVersionedReadV0<T> =
	| { readonly ok: true; readonly schemaVersion: string; readonly value: T }
	| {
			readonly ok: false;
			readonly kind: EndoVersionFailureKindV0;
			/** The declared version, for `unsupported-version` and `invalid` only, bounded and printable. */
			readonly schemaVersion?: string;
			readonly message: string;
	  };

/** What a validator throws to say why a record of a known version is invalid (a short message, never the record). */
export class EndoInvalidRecordV0 extends TypeError {
	constructor(detail: string) {
		super(detail);
		this.name = "EndoInvalidRecordV0";
	}
}

/** The throwing form of a failed read. A `TypeError`, so callers that already expect one keep working. */
export class EndoSchemaVersionErrorV0 extends TypeError {
	readonly kind: EndoVersionFailureKindV0;
	readonly schemaVersion: string | undefined;
	constructor(failure: Extract<EndoVersionedReadV0<unknown>, { ok: false }>) {
		super(failure.message);
		this.name = "EndoSchemaVersionErrorV0";
		this.kind = failure.kind;
		this.schemaVersion = failure.schemaVersion;
	}
}

const MAX_LABEL_V0 = 80;

const endoBoundedVersionV0 = (value: string): string =>
	value.length > MAX_LABEL_V0 ? `${value.slice(0, MAX_LABEL_V0)}…` : value;

/** A declared version string made safe to print: bounded, quoted, with control characters escaped. */
export function endoSafeVersionLabelV0(value: string): string {
	// JSON.stringify escapes control characters but leaves U+2028/U+2029 literal; both are line breaks to some consumers.
	return JSON.stringify(endoBoundedVersionV0(value)).replace(/[\u2028\u2029]/g, (c) =>
		c === "\u2028" ? "\\u2028" : "\\u2029",
	);
}

/**
 * Build a table. Each entry names a version and its exact validator. The version must be a non-empty string and
 * unique; the table is frozen.
 */
export function defineEndoVersionTableV0<T>(
	family: string,
	entries: readonly (readonly [version: string, validator: EndoVersionValidatorV0<T>])[],
): EndoVersionTableV0<T> {
	const validators = new Map<string, EndoVersionValidatorV0<T>>();
	for (const [version, validator] of entries) {
		if (typeof version !== "string" || version.length === 0) throw new TypeError(`${family}: bad version`);
		if (validators.has(version)) throw new TypeError(`${family}: duplicate version ${version}`);
		validators.set(version, validator);
	}
	// The map lives in this closure: a caller holds only a lookup, so a table cannot be extended or shrunk after the fact.
	return Object.freeze({
		family,
		versions: Object.freeze([...validators.keys()]),
		validatorFor: (version: string) => validators.get(version),
	});
}

/** The declared `schemaVersion`, read once as an own data property (never through a getter or the prototype). */
function declaredVersion(value: Record<string, unknown>): { found: false } | { found: true; version: unknown } {
	const descriptor = Object.getOwnPropertyDescriptor(value, "schemaVersion");
	if (descriptor === undefined) return { found: false };
	if (!("value" in descriptor)) return { found: true, version: undefined };
	return { found: true, version: descriptor.value };
}

/**
 * Read `value` under the version it declares. Never throws for a bad input; a validator that throws something other
 * than `EndoInvalidRecordV0` is a defect and propagates.
 */
export function readEndoVersionedV0<T>(table: EndoVersionTableV0<T>, value: unknown): EndoVersionedReadV0<T> {
	if (!isPlainJsonObjectV0(value))
		return { ok: false, kind: "not-an-object", message: `${table.family}: not a plain JSON object` };
	const declared = declaredVersion(value as Record<string, unknown>);
	if (!declared.found)
		return { ok: false, kind: "missing-version", message: `${table.family}: the record declares no schemaVersion` };
	if (typeof declared.version !== "string")
		return { ok: false, kind: "version-not-string", message: `${table.family}: schemaVersion is not a string` };
	const version = declared.version;
	const validator = table.validatorFor(version);
	if (validator === undefined)
		return {
			ok: false,
			kind: "unsupported-version",
			schemaVersion: endoBoundedVersionV0(version),
			message: `${table.family}: unsupported schemaVersion ${endoSafeVersionLabelV0(version)} (this reader knows ${table.versions.join(", ")})`,
		};
	let validated: T | null;
	try {
		validated = validator(value);
	} catch (error) {
		if (!(error instanceof EndoInvalidRecordV0)) throw error;
		return {
			ok: false,
			kind: "invalid",
			schemaVersion: version,
			message: `${table.family}: record declares ${version} but does not satisfy ${version}: ${error.message}`,
		};
	}
	if (validated === null)
		return {
			ok: false,
			kind: "invalid",
			schemaVersion: version,
			message: `${table.family}: record declares ${version} but does not satisfy ${version}`,
		};
	return { ok: true, schemaVersion: version, value: validated };
}

/** `readEndoVersionedV0`, throwing `EndoSchemaVersionErrorV0` on failure. */
export function parseEndoVersionedV0<T>(table: EndoVersionTableV0<T>, value: unknown): T {
	const read = readEndoVersionedV0(table, value);
	if (!read.ok) throw new EndoSchemaVersionErrorV0(read);
	return read.value;
}

/** The first own key of `value` that is not in `allowed` (a closed record's unknown field), or undefined. */
export function endoFirstUnknownKeyV0(value: object, allowed: readonly string[]): string | symbol | undefined {
	for (const key of Reflect.ownKeys(value)) if (typeof key !== "string" || !allowed.includes(key)) return key;
	return undefined;
}

/** A key, path or any other attacker-controlled value made safe for a message, without coercing it. */
export function endoSafeTextV0(value: unknown): string {
	// Never coerce an attacker-controlled value: String() on an object can throw.
	if (typeof value === "string") return endoSafeVersionLabelV0(value);
	if (typeof value === "symbol") return endoSafeVersionLabelV0(value.description ?? "symbol");
	return `<${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}>`;
}
