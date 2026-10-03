// The Endo identity v0 grammar: stable, namespaced identifiers for protocol objects. An identifier is a
// language-neutral string of the form `endo.<kind>.<local>`: a closed namespace `<kind>` chosen by the protocol
// and an opaque emitter-chosen `<local>` part. Parsing is unambiguous: the namespace is the first segment after
// the prefix and everything after the next dot is the local part.

/** The prefix every Endo identifier carries. */
export const ENDO_IDENTIFIER_PREFIX = "endo.";

/**
 * The closed v0 namespaces — the README's example list, `endo.session.*` through `endo.evidence.*`. Nothing else is
 * a v0 identifier; the remaining README object kinds (artifact, decision, proposal, receipt, visualization state)
 * are v1 additions, not v0 identifiers.
 */
export type EndoIdentifierKindV0 =
	| "session"
	| "run"
	| "event"
	| "node"
	| "edge"
	| "model"
	| "tool"
	| "experiment"
	| "candidate"
	| "evidence";

/** The closed v0 namespaces, machine-checkable. */
export const ENDO_IDENTIFIER_KINDS_V0 = [
	"session",
	"run",
	"event",
	"node",
	"edge",
	"model",
	"tool",
	"experiment",
	"candidate",
	"evidence",
] as const satisfies readonly EndoIdentifierKindV0[];

/** The local-part grammar: 1-256 characters of `[A-Za-z0-9._-]`. Dots are allowed because the local part is opaque. */
const ENDO_IDENTIFIER_LOCAL_V0 = /^[A-Za-z0-9._-]{1,256}$/;

/** The dotted-kind grammar: 1+ segments of `[a-z][a-z0-9-]*`. */
const DOT_SEPARATED_KIND_V0 = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/** A parsed identifier: the namespace plus the opaque local part. */
export interface EndoIdentifierV0 {
	kind: EndoIdentifierKindV0;
	local: string;
}

/** Parses `endo.<kind>.<local>`. Returns null when the prefix, the namespace, or the local-part grammar fails. */
export function parseEndoIdentifierV0(value: string): EndoIdentifierV0 | null {
	if (!value.startsWith(ENDO_IDENTIFIER_PREFIX)) return null;
	const rest = value.slice(ENDO_IDENTIFIER_PREFIX.length);
	const dot = rest.indexOf(".");
	if (dot <= 0) return null;
	const kind = rest.slice(0, dot) as EndoIdentifierKindV0;
	if (!(ENDO_IDENTIFIER_KINDS_V0 as readonly string[]).includes(kind)) return null;
	const local = rest.slice(dot + 1);
	if (!ENDO_IDENTIFIER_LOCAL_V0.test(local)) return null;
	return { kind, local };
}

/**
 * Formats a v0 identifier. Returns null (not a throw) when either part fails its grammar, so formatting can be used
 * for canonicalization without try/catch. A formatted value always round-trips through `parseEndoIdentifierV0`.
 */
export function formatEndoIdentifierV0(kind: EndoIdentifierKindV0, local: string): string | null {
	if (!(ENDO_IDENTIFIER_KINDS_V0 as readonly string[]).includes(kind)) return null;
	if (!ENDO_IDENTIFIER_LOCAL_V0.test(local)) return null;
	return `${ENDO_IDENTIFIER_PREFIX}${kind}.${local}`;
}

/** True when `value` is a well-formed v0 identifier, optionally confined to a single namespace. */
export function isEndoIdentifierV0(value: string, kind?: EndoIdentifierKindV0): boolean {
	const parsed = parseEndoIdentifierV0(value);
	if (!parsed) return false;
	return kind === undefined || parsed.kind === kind;
}

/** True for a dotted kind of 1+ segments (object types, e.g. `claim`, `hypothesis`), at most 128 characters. */
export function isWellFormedKindV0(kind: string): boolean {
	return kind.length <= 128 && DOT_SEPARATED_KIND_V0.test(kind);
}

/** True for a dotted kind of 2+ segments (event types, e.g. `session.started`), at most 128 characters. */
export function isWellFormedEventKindV0(kind: string): boolean {
	return kind.length <= 128 && kind.includes(".") && DOT_SEPARATED_KIND_V0.test(kind);
}
