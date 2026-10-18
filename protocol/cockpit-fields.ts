// The timeline presentation policy v0, shared by the projection that applies it and the validator that enforces it.
//
// WHAT may be presented from an event is one definition, here, not two: the allowlist of payload fields per event kind
// (with the basis and type of each), the set of kinds the producers record (RECOGNIZED), the kinds that carry a
// flag by themselves, and the shapes in which an opaque producer name or runtime session reference is admitted.
// `cockpit/projections/session-timeline.ts` reads this to build entries; `protocol/cockpit.ts` reads the same to reject a
// serialized entry that carries a field, a basis, a value type, a flag or an opaque value the policy does not allow.
// Changing what the cockpit may show is a change to this file, and both sides follow.
//
// The protocol imports only the protocol.

import {
	type EndoIdentifierKindV0,
	isEndoIdentifierV0,
	isWellFormedEventKindV0,
	isWellFormedKindV0,
	parseEndoIdentifierV0,
} from "./identity.ts";
import { ENDO_INTERVENTION_KINDS_V0 } from "./intervention.ts";
import { ENDO_DIGEST_KEY_ID_PATTERN_V0, ENDO_KEYED_DIGEST_VALUE_PATTERN_V0 } from "./keyed-digest-shape.ts";
import { ENDO_LIFECYCLE_KINDS_V0, isEndoLifecycleKindV0 } from "./session-lifecycle.ts";

function freezeDeep<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) freezeDeep(item);
	}
	return value;
}

export type EndoCockpitFieldBasisV0 = "observed" | "reported" | "derived";
/** "id": an Endophasia identifier, presented in the public form (or as its deterministic alias). */
export type EndoCockpitFieldTypeV0 = "string" | "number" | "boolean" | "id";
/** [exposed key, payload path, basis, type, null allowed] */
export type EndoCockpitFieldSpecV0 = readonly [
	key: string,
	path: string,
	basis: EndoCockpitFieldBasisV0,
	type: EndoCockpitFieldTypeV0,
	nullable?: true,
];

const instance: EndoCockpitFieldSpecV0 = ["instance", "instance", "observed", "string"];
const runtimeEvent: EndoCockpitFieldSpecV0 = ["runtimeEvent", "runtimeEvent", "reported", "string"];
const turns: EndoCockpitFieldSpecV0 = ["turns", "turns", "derived", "number"];
const stopReason: EndoCockpitFieldSpecV0 = ["stopReason", "stopReason", "reported", "string"];

/** The allowlist per event kind. A recognised kind absent from this table is shown by its envelope only. */
export const ENDO_COCKPIT_FIELD_SPECS_V0: Readonly<Record<string, readonly EndoCockpitFieldSpecV0[]>> = freezeDeep({
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
		["fingerprintId", "fingerprintId", "observed", "id"],
		["identityDigest", "identityDigest", "derived", "string"],
		["version", "version", "reported", "string", true],
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
		["previousFingerprintId", "previousFingerprintId", "observed", "id"],
		["currentFingerprintId", "currentFingerprintId", "observed", "id"],
		["previousVersion", "previousVersion", "reported", "string", true],
		["currentVersion", "currentVersion", "reported", "string", true],
	],
	"harness.protocol-fault": [["fault", "fault", "observed", "string"]],
	"harness.session-mismatch": [],
	"runtime.unrecognized-event": [runtimeEvent],
	"runtime.malformed-event": [runtimeEvent],
});

/**
 * Every kind the repository's producers record in the durable event log, besides the lifecycle and intervention kinds
 * (taken from their protocol tables) and the kinds with a field table. Audit rule: a kind is here when an adapter's
 * recorder, attachment or event mapping emits it into a session's event store (adapters/pi/{mapping,attachment}.ts,
 * adapters/acp/client*.ts and translate*.ts). Capability names (`control.model`, `session.identity`, ...), loss-ledger
 * keys and the proxy's `capture.*` events (a separate capture store) are not event kinds of this log.
 */
export const ENDO_COCKPIT_RECOGNIZED_KINDS_V0: readonly string[] = freezeDeep([
	...ENDO_LIFECYCLE_KINDS_V0,
	...Object.keys(ENDO_INTERVENTION_KINDS_V0),
	...Object.keys(ENDO_COCKPIT_FIELD_SPECS_V0),
	"agent.prompt-accepted",
	"agent.prompt-failed",
	"agent.prompt-refused",
	"agent.prompt-responded",
	"agent.state-reported",
	"config.thinking-changed",
	"control.message-refused",
	"control.refused",
	"control.unavailable",
	"extension.dialog-cancelled",
	"extension.ui-requested",
	"harness.acp-initialized",
	"harness.late-message",
	"harness.prompt-timeout",
	"permission.decided",
	"permission.requested",
	"session.close-accepted",
	"session.config-observed",
	"session.info-changed",
	"session.listed",
	"session.state-conflict",
	"session.update-observed",
]);

export const ENDO_COCKPIT_INTERRUPTION_KINDS_V0: readonly string[] = freezeDeep([
	"lifecycle.interrupted",
	"lifecycle.detached",
	"harness.process-exited",
]);
export const ENDO_COCKPIT_DISCONTINUITY_KINDS_V0: readonly string[] = freezeDeep([
	"lifecycle.session-resumed",
	"harness.runtime-changed",
]);
export const ENDO_COCKPIT_ANOMALY_KINDS_V0: readonly string[] = freezeDeep([
	"lifecycle.anomaly",
	"harness.protocol-fault",
	"harness.session-mismatch",
	"runtime.malformed-event",
]);
export const ENDO_COCKPIT_UNRECOGNIZED_KINDS_V0: readonly string[] = freezeDeep([
	"lifecycle.unrecognized-runtime-event",
	"runtime.unrecognized-event",
]);

/**
 * The runtime session reference shapes admitted for presentation: a UUID, the digest form the ACP recorder writes for an
 * id that is long or not printable (`sha256-` and 48 hex digits), and the id Endophasia itself generates for a Pi
 * session (`endo-<attachment>-<12 hex digits>`). A runtime may choose any other string, including one that is a path or a
 * token; that cannot be told from a harmless id, so it is withheld whole.
 */
const ADMITTED_RUNTIME_SESSION: readonly RegExp[] = [
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	/^sha256-[0-9a-f]{48}$/,
	/^endo-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{12}$/,
];

/**
 * The producer name as the event wrote it (any non-empty string), presented only in the shape Endophasia's own producers
 * use: a lowercase prefix, optionally `:` and an attachment-like name. Anything else is withheld whole.
 */
const ADMITTED_PRODUCER = /^[a-z][a-z0-9-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;

export const ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0 =
	"the attachment recorded two different runtime session references (piSessionId and acpSessionId); neither is presented";

/** Kinds that carry a flag by what they are; a flag a payload decides (a store reopened after damage) is not here. */
export const ENDO_COCKPIT_PAYLOAD_FLAG_KINDS_V0: Readonly<Record<string, "discontinuity">> = freezeDeep({
	"harness.store-opened": "discontinuity",
});

/** The most items of a declared `unavailable` list the projection considers; at most this many dynamic fields appear. */
export const ENDO_COCKPIT_MAX_DECLARED_UNAVAILABLE_V0 = 32;

/** The kinds whose `unavailable` list of `{ field, reason }` becomes dynamic `unavailable.<field>` presented fields. */
export const ENDO_COCKPIT_DECLARED_UNAVAILABLE_KINDS_V0: readonly string[] = freezeDeep([
	"lifecycle.session-started",
	"lifecycle.session-resumed",
]);

/** An opaque producer name is presented only in the shape Endophasia's own producers use. */
export function endoCockpitProducerAdmittedV0(producer: string): boolean {
	return ADMITTED_PRODUCER.test(producer) && !endoCockpitTextUnsafeV0(producer);
}

/** An opaque runtime session reference is presented only in a shape Endophasia writes or a UUID. */
export function endoCockpitRuntimeSessionAdmittedV0(reference: string): boolean {
	return ADMITTED_RUNTIME_SESSION.some((shape) => shape.test(reference)) && !endoCockpitTextUnsafeV0(reference);
}

/** Whether a kind is one the producers record (or a lifecycle/intervention kind this version defines). */
export function endoCockpitKindRecognizedV0(kind: string): boolean {
	return ENDO_COCKPIT_RECOGNIZED_KINDS_V0.includes(kind);
}

/**
 * The fields shown from a tool event's keyed digest (`argsDigest`, `resultDigest`): each is a member of a whole
 * EndoKeyedDigestV0, shown only when the complete parent object is one (protocol/keyed-digest-shape.ts), and the two
 * members of a digest are shown together or not at all.
 */
export const ENDO_COCKPIT_KEYED_DIGEST_FIELDS_V0: Readonly<Record<string, { parent: string; partner: string }>> =
	freezeDeep({
		argsDigest: { parent: "argsDigest", partner: "argsDigestKeyId" },
		argsDigestKeyId: { parent: "argsDigest", partner: "argsDigest" },
		resultDigest: { parent: "resultDigest", partner: "resultDigestKeyId" },
		resultDigestKeyId: { parent: "resultDigest", partner: "resultDigest" },
	});

/** The shape a presented value of a field must have, by field key (an opaque digest part, a kind, an identifier namespace). */
const FIELD_ADMISSION: Readonly<Record<string, (value: string) => boolean>> = freezeDeep({
	// The runtime identity digest, as its keyed token (the same token the registry views carry for it).
	identityDigest: (value: string) => /^[0-9a-f]{64}$/.test(value),
	// A runtime family is a kind the source names: one in the reserved alias namespace is withheld whole, not shown as written.
	runtime: (value: string) => isEndoCockpitSourceKindAdmittedV0(value),
	// A fingerprint reference is an evidence identifier (an alias keeps its `endo.<kind>.` segment, so the namespace holds for
	// the source value and for what is presented alike); an identifier of another namespace is not a fingerprint reference.
	fingerprintId: (value: string) => isEndoIdentifierV0(value, "evidence"),
	previousFingerprintId: (value: string) => isEndoIdentifierV0(value, "evidence"),
	currentFingerprintId: (value: string) => isEndoIdentifierV0(value, "evidence"),
	argsDigest: (value: string) => ENDO_KEYED_DIGEST_VALUE_PATTERN_V0.test(value),
	resultDigest: (value: string) => ENDO_KEYED_DIGEST_VALUE_PATTERN_V0.test(value),
	argsDigestKeyId: (value: string) => ENDO_DIGEST_KEY_ID_PATTERN_V0.test(value),
	resultDigestKeyId: (value: string) => ENDO_DIGEST_KEY_ID_PATTERN_V0.test(value),
});

/** What a presented field of an entry of this kind may be. */
export interface EndoCockpitFieldRuleV0 {
	/** The basis a value of this field may carry; the field may also be "unavailable". */
	basis: EndoCockpitFieldBasisV0;
	type: EndoCockpitFieldTypeV0;
	nullable: boolean;
	/** A string value must also be in an admitted opaque shape. */
	admitted?: (value: string) => boolean;
	/** The only unavailable form this field may take (a dynamic declared gap carries any reason). */
	dynamic?: true;
}

/**
 * The rule for field `key` of an entry of `kind`, or null when the policy presents no such field. Covers the allowlist,
 * the `harness.attached` runtime session reference (a special-case projection of either producer's field), and the
 * dynamic `unavailable.<field>` gaps a session start declares.
 */
export function endoCockpitFieldRuleV0(kind: string, key: string): EndoCockpitFieldRuleV0 | null {
	const specs = Object.hasOwn(ENDO_COCKPIT_FIELD_SPECS_V0, kind) ? ENDO_COCKPIT_FIELD_SPECS_V0[kind]! : [];
	const spec = specs.find((item) => item[0] === key);
	// The runtime's session reference is opaque wherever it is recorded, so it is admitted by shape wherever it appears.
	if (key === "runtimeSessionId" && (spec !== undefined || kind === "harness.attached"))
		return { basis: "reported", type: "string", nullable: false, admitted: endoCockpitRuntimeSessionAdmittedV0 };
	if (spec !== undefined) {
		const digest = FIELD_ADMISSION[key];
		return {
			basis: spec[2],
			type: spec[3],
			nullable: spec[4] === true,
			...(digest === undefined ? {} : { admitted: digest }),
		};
	}
	if (kind === "harness.attached" && key === "runtimeSessionId")
		return { basis: "reported", type: "string", nullable: false, admitted: endoCockpitRuntimeSessionAdmittedV0 };
	if (ENDO_COCKPIT_DECLARED_UNAVAILABLE_KINDS_V0.includes(kind) && key.startsWith("unavailable."))
		return { basis: "reported", type: "string", nullable: false, dynamic: true };
	return null;
}

/**
 * Whether a field of this kind may be "unavailable" for this reason, as the projection produces it. A runtime-reported
 * field may carry the reason the runtime gave (any presentable text) and a declared gap likewise; any string field may be
 * withheld whole by the boundary (the fixed text). A derived or observed number or boolean is never unavailable: a value
 * that is not of its type is omitted, not replaced. The runtime session reference of `harness.attached` is also
 * unavailable when two producers' references conflict.
 */
export function endoCockpitUnavailableAdmittedV0(kind: string, key: string, reason: string): boolean {
	const rule = endoCockpitFieldRuleV0(kind, key);
	if (rule === null) return false;
	if (kind === "harness.attached" && key === "runtimeSessionId" && reason === ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0)
		return true;
	// A member of a keyed digest is shown only beside its partner, and only when both are presentable (the projector omits the
	// pair otherwise): the value is 64 lowercase hex characters and the key id, which names the comparison domain the value is
	// read in, is a grammar-checked name. Neither has an unavailable form.
	if (Object.hasOwn(ENDO_COCKPIT_KEYED_DIGEST_FIELDS_V0, key)) return false;
	if (reason === ENDO_COCKPIT_WITHHELD_TEXT_V0 && (rule.type === "string" || rule.type === "id")) return true;
	if (kind === "harness.attached" && key === "runtimeSessionId") return false;
	return (rule.basis === "reported" || rule.dynamic === true) && endoCockpitTextPresentableV0(reason);
}

/** A kind the policy flags "unrecognized" by itself: not recorded by any producer, or named so, or an unknown lifecycle kind. */
export function endoCockpitKindUnrecognizedV0(kind: string): boolean {
	return (
		ENDO_COCKPIT_UNRECOGNIZED_KINDS_V0.includes(kind) ||
		!endoCockpitKindRecognizedV0(kind) ||
		(kind.startsWith("lifecycle.") && !isEndoLifecycleKindV0(kind))
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Text and identifier admission (shared by the projections and the validators)
// ---------------------------------------------------------------------------------------------------------------

/**
 * What stands in place of a recorded free-text value that appears to embed a local path, a network address, a credential
 * or control characters, or that is too long to present whole. A fixed text (50 characters, so it fits every bounded
 * field): it reveals nothing of the original and is the same on every run.
 */
export const ENDO_COCKPIT_WITHHELD_TEXT_V0 = "withheld: looks like a path, address or credential";

/** The longest free-text field value presented whole. A longer value is withheld, never cut: a cut can split a secret. */
export const ENDO_COCKPIT_MAX_FIELD_TEXT_V0 = 256;

/**
 * Text that looks like it carries a local path, a network address, a credential or control characters. A heuristic for
 * free text an author wrote: it is not a secret scanner and a pass does not certify the text safe, so every value it is
 * applied to is ALSO bounded, and values whose shape is known (identifiers, digests, versions of the contract) are
 * admitted by shape instead. What it flags is withheld whole, never partly rewritten, so the result is deterministic.
 * The text is normalised first (NFKC; zero-width, bidirectional and control characters removed) and tested both as
 * written and normalised, so a secret split by an invisible character is still seen.
 */
const SENSITIVE_TEXT: readonly RegExp[] = [
	/(?:^|[\s"'`([{=:,;<])(?:\/|~\/|\.{1,2}\/)[^\s]/,
	/\b[A-Za-z]:[\\/]/,
	/\\\\[^\s\\]+\\/,
	/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S/,
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/,
	/\bxox[abprs]-[A-Za-z0-9-]{8,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
	/\b(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[=:]\s*\S{4,}/i,
];

/** Control characters and invisible or direction-changing characters, written as escapes so none is literal here. */
const INVISIBLE_CLASS =
	"[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]";
const CONTROL_OR_INVISIBLE = new RegExp(INVISIBLE_CLASS);
const CONTROL_OR_INVISIBLE_ALL = new RegExp(INVISIBLE_CLASS, "g");

export function endoCockpitTextUnsafeV0(text: string): boolean {
	if (CONTROL_OR_INVISIBLE.test(text)) return true;
	const folded = text.normalize("NFKC").replace(CONTROL_OR_INVISIBLE_ALL, "");
	return SENSITIVE_TEXT.some((pattern) => pattern.test(text) || pattern.test(folded));
}

/** Free text fit to present whole: non-empty, within `max`, and not unsafe. Tested on the whole value before any bound. */
export function endoCockpitTextPresentableV0(text: string, max = ENDO_COCKPIT_MAX_FIELD_TEXT_V0): boolean {
	return text.length >= 1 && text.length <= max && !endoCockpitTextUnsafeV0(text);
}

/** The text itself, or the fixed withheld text when it is not presentable. */
export function endoCockpitPresentableTextV0(text: string, max = ENDO_COCKPIT_MAX_FIELD_TEXT_V0): string {
	return endoCockpitTextPresentableV0(text, max) ? text : ENDO_COCKPIT_WITHHELD_TEXT_V0;
}

/**
 * Whether an identifier is a content-addressed evidence record id: `endo.evidence.<name>.<64 hex>`, where the hex is the
 * sha256 of the record's whole body (a runtime fingerprint, a change, a notification, a capability check, an intervention).
 * That body can contain facts the cockpit withholds (a real path, the identity and configuration digests, an expected or
 * observed value), so the id is a commitment to them: anyone who can guess the body can recompute it and confirm the guess.
 * Such an id is never presented as it is, wherever it occurs; it is presented as its keyed alias (common.ts), which gives
 * the same value for the same id everywhere under one key. Event ids hash only the runtime's own session and entry
 * identifiers, which the cockpit presents, and are not in this family.
 */
export function isEndoCockpitContentAddressedIdV0(value: string): boolean {
	const parsed = parseEndoIdentifierV0(value);
	if (parsed === null || parsed.kind !== "evidence") return false;
	return /^[0-9a-f]{64}$/.test(parsed.local.split(".").at(-1) ?? "");
}

const SAFE_ID_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The generated-alias namespace. A segment that begins `withheld-` is RESERVED for the placeholders the cockpit generates
 * (an identifier's alias, a withheld capability or event kind): no source identifier or kind in it is ever presented as it
 * is, so a generated alias can never be equal to anything a source wrote, and two distinct sources cannot collapse into
 * one public value. Two sets share the shapes below and are disjoint by construction: what a SOURCE value must be to pass
 * through unchanged (shape, content, NOT reserved), and what the generator emits in its place (a reserved segment of one
 * exact form). A wire record may carry either, and nothing else in the namespace.
 */
const RESERVED_SEGMENT = /^withheld-/;

/**
 * The one segment a generated alias is: `withheld-` and the first 32 lowercase hex digits of a keyed token
 * (cockpitAliasesV0 in cockpit/projections/common.ts). Whether the digits ARE the token of anything is not decidable
 * without the key and is not claimed; what the wire can and does enforce is the exact shape.
 */
const GENERATED_ALIAS_SEGMENT = /^withheld-[0-9a-f]{32}$/;

/** A dotted string (an identifier's local part, a kind) with a segment in the reserved namespace. */
const hasReservedSegment = (dotted: string): boolean =>
	dotted.split(".").some((segment) => RESERVED_SEGMENT.test(segment));

/** The identifier of a shape and content a record may carry, before the reserved namespace is considered. */
function publicIdShapeV0(
	value: string,
	kind?: EndoIdentifierKindV0,
): { kind: EndoIdentifierKindV0; local: string } | null {
	const parsed = parseEndoIdentifierV0(value);
	if (parsed === null || (kind !== undefined && parsed.kind !== kind)) return null;
	if (isEndoCockpitContentAddressedIdV0(value)) return null;
	if (!parsed.local.split(".").every((segment) => segment.length <= 64 && SAFE_ID_SEGMENT.test(segment))) return null;
	// Admitted by shape AND by content: what the text policy flags is admitted nowhere.
	return endoCockpitTextUnsafeV0(value) ? null : parsed;
}

/**
 * Whether an identifier is a source identifier that may be presented as it is: a well-formed Endophasia identifier whose
 * opaque local part is lowercase letters, digits and hyphens in dot-separated segments of at most 64 characters, outside the
 * reserved namespace. Real identifiers are of that shape (digests, counters, attachment-derived names). A credential has no
 * reason to be, but a lowercase hex token is indistinguishable from the digests identifiers legitimately carry; that
 * residual is stated, not claimed away. An identifier of another shape is presented as a deterministic alias.
 */
export function isEndoCockpitSourceIdAdmittedV0(value: string, kind?: EndoIdentifierKindV0): boolean {
	const parsed = publicIdShapeV0(value, kind);
	return parsed !== null && !hasReservedSegment(parsed.local);
}

/**
 * Whether an identifier is exactly what `cockpitAliasesV0.id` generates: `endo.<namespace>.withheld-<32 lowercase hex>`, the
 * local part ONE reserved segment and nothing around it. (The namespace is the source identifier's own; one that is not an
 * identifier is aliased in `evidence`.)
 */
export function isEndoCockpitGeneratedIdAliasV0(value: string, kind?: EndoIdentifierKindV0): boolean {
	const parsed = publicIdShapeV0(value, kind);
	return parsed !== null && GENERATED_ALIAS_SEGMENT.test(parsed.local);
}

/**
 * Whether an identifier may be carried on the wire: a source identifier admitted as it is, or a generated alias in its exact
 * form. A reserved segment of any other form (`withheld-not-a-token`, a token of another length or case, a segment beside
 * others) is no source value and no generator output, so it is refused.
 */
export function isEndoCockpitPublicIdV0(value: string, kind?: EndoIdentifierKindV0): boolean {
	return isEndoCockpitSourceIdAdmittedV0(value, kind) || isEndoCockpitGeneratedIdAliasV0(value, kind);
}

/**
 * Whether a dotted kind (a capability, an event kind, a runtime family) may be presented as it is: in the protocol's kind
 * grammar, not flagged, not in the reserved namespace. A value of another shape is not a kind and is withheld or aliased.
 */
export function isEndoCockpitSourceKindAdmittedV0(kind: string): boolean {
	return isWellFormedKindV0(kind) && !endoCockpitTextUnsafeV0(kind) && !hasReservedSegment(kind);
}

/**
 * Whether a kind is exactly what `cockpitAliasesV0.kind` generates: `withheld-<32 lowercase hex>`, one segment. This is the
 * form of a runtime family or a capability name that was withheld; a timeline event kind carries it wrapped (below).
 */
export function isEndoCockpitGeneratedKindAliasV0(kind: string): boolean {
	return GENERATED_ALIAS_SEGMENT.test(kind);
}

/** A runtime family or capability name (a bare label) as the wire carries it: admitted as written, or the bare alias. */
export function isEndoCockpitPublicKindV0(kind: string): boolean {
	return isEndoCockpitSourceKindAdmittedV0(kind) || isEndoCockpitGeneratedKindAliasV0(kind);
}

const EVENT_KIND_ALIAS_PREFIX = "other.";

/**
 * An event kind as a timeline entry carries it: a dotted kind of two or more segments admitted as written, or the alias of
 * one that is not, wrapped as `other.<alias>` (the category "other" holds it; the producer's `presentedKind`). The bare alias
 * is not an event kind, and the wrapper is not a bare label's: the two contexts differ and are checked apart.
 */
export function isEndoCockpitPublicEventKindV0(kind: string): boolean {
	if (!isWellFormedEventKindV0(kind) || endoCockpitTextUnsafeV0(kind)) return false;
	return (
		!hasReservedSegment(kind) ||
		(kind.startsWith(EVENT_KIND_ALIAS_PREFIX) &&
			isEndoCockpitGeneratedKindAliasV0(kind.slice(EVENT_KIND_ALIAS_PREFIX.length)))
	);
}

/** The name of a declared-unavailable gap (`unavailable.<name>`): a short plain label. */
export function endoCockpitGapNameAdmittedV0(name: string): boolean {
	return /^[A-Za-z][A-Za-z0-9._-]{0,99}$/.test(name) && !endoCockpitTextUnsafeV0(name);
}

// ---------------------------------------------------------------------------------------------------------------
// Fixed provenance texts (shared by the projections and the validators)
// ---------------------------------------------------------------------------------------------------------------

/** Why a fingerprint fact is unavailable when the fingerprint recorded it as not collected. The recorded reason is not shown. */
export const ENDO_COCKPIT_FINGERPRINT_GAP_REASON_V0 =
	"the fingerprint records this fact as not collected; the recorded reason is not presented";

/** The recorded fingerprint fields that are not presented: local paths and the version command's raw output. */
export const ENDO_COCKPIT_WITHHELD_FINGERPRINT_FIELDS_V0: readonly string[] = freezeDeep([
	"local.package.root",
	"local.realPath",
	"local.requested",
	"local.resolvedPath",
	"reported.versionText",
]);

/** The evidence fields that are not presented. */
export const ENDO_COCKPIT_WITHHELD_EVIDENCE_FIELDS_V0: readonly string[] = freezeDeep([
	"expected",
	"inputsDigest",
	"observed",
]);

/** The runtime family claim's reason when no record names one. */
export const ENDO_COCKPIT_NO_RUNTIME_REASON_V0 = "no runtime family is recorded for this attachment";

/** The runtime family claim's reason when the registry could not be read (`state` is its source state). */
export const endoCockpitUnreadableRuntimeReasonV0 = (state: string): string =>
	`the registry is ${state}; no runtime is recorded here`;

/** The reasons a usage claim is unavailable. */
export const ENDO_COCKPIT_USAGE_REASONS_V0: readonly string[] = freezeDeep([
	"the event records no entry details",
	"the event records no usage",
	"the recorded usage is not in the expected shape",
]);

/**
 * How much a check kind can establish (adapters/pi/capabilities.ts: `requires` is the cheapest kind that can establish a
 * capability). Evidence from a costlier kind may legitimately stand for a cheaper requirement (a live study that re-tests
 * what a local check does); evidence from a cheaper kind cannot stand for a costlier one.
 */
export const ENDO_COCKPIT_CHECK_COST_V0: Readonly<Record<string, number>> = freezeDeep({
	"static-surface": 0,
	"local-protocol": 1,
	"live-study": 2,
});

/**
 * The fewest top-level payload keys an entry of this kind can have left unpresented, as the presented fields prove it:
 * a field read from a nested path leaves the rest of its top-level key withheld, and a value the boundary replaced
 * (the fixed withheld text) leaves its whole key withheld. A key another field presents whole is not counted. Distinct
 * keys only. A bound, not a count: an absent usage or a declared gap proves
 * nothing here, and the payload's other keys cannot be seen from the entry. The one synthesized field, a
 * `harness.attached` runtime session reference the boundary replaced (the fixed withheld text), proves that at least one of
 * the two producers' keys (`piSessionId`, `acpSessionId`) was omitted; which one, or both, the wire does not say, so it
 * counts once. A conflict between the two names proves both omitted.
 */
export function endoCockpitWithheldLowerBoundV0(
	kind: string,
	fields: Readonly<Record<string, { basis: string; reason?: unknown }>>,
	usage: { basis: string; reason?: unknown } | null = null,
): number {
	if (!Object.hasOwn(ENDO_COCKPIT_FIELD_SPECS_V0, kind)) return 0;
	const withheld = new Set<string>();
	// A durable entry's usage is read from `details.usage`: any usage claim but "the entry has no details" proves `details`
	// is an object, whose members are shown only by nested path. (A message's own `usage` key proves nothing here: it may
	// be presented whole, and an absent one proves no key.)
	if (
		kind === "session.entry-observed" &&
		usage !== null &&
		!(usage.basis === "unavailable" && usage.reason === ENDO_COCKPIT_USAGE_REASONS_V0[0])
	)
		withheld.add("details");
	// A message's own malformed usage: the recorded value existed under the top-level `usage` key and is not presented whole.
	// (No usage, a user message's and a valid, reported usage prove nothing here.)
	if (
		kind === "message.completed" &&
		usage?.basis === "unavailable" &&
		usage.reason === ENDO_COCKPIT_USAGE_REASONS_V0[2]
	)
		withheld.add("usage");
	const session = fields.runtimeSessionId;
	if (kind === "harness.attached" && session?.basis === "unavailable") {
		// A replaced reference proves one omitted key, which of the two the wire does not say. A conflict is only ever made of
		// two non-empty values under the two names, neither of which is presented: it proves both.
		if (session.reason === ENDO_COCKPIT_WITHHELD_TEXT_V0) withheld.add("piSessionId|acpSessionId");
		else if (session.reason === ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0) {
			withheld.add("piSessionId");
			withheld.add("acpSessionId");
		}
	}
	const whole = new Set<string>();
	for (const spec of ENDO_COCKPIT_FIELD_SPECS_V0[kind]!) {
		const field = Object.hasOwn(fields, spec[0]) ? fields[spec[0]]! : undefined;
		if (field === undefined) continue;
		const top = spec[1].split(".")[0]!;
		const replaced = field.basis === "unavailable" && field.reason === ENDO_COCKPIT_WITHHELD_TEXT_V0;
		if (spec[1].includes(".") || replaced) withheld.add(top);
		else whole.add(top);
	}
	for (const key of whole) withheld.delete(key);
	return withheld.size;
}

/**
 * What an evidence record's dependencies say against the fingerprint the state names, as the capability projection derives
 * it and the snapshot validator re-derives it from the views it embeds: the one predicate, over whatever form of the digest
 * both sides hold (raw in the projection, its keyed token on the wire: equal values are equal in either). A fact the named
 * fingerprint does not show (its identity unavailable, so no digest or confidence) is `null`: undecidable, never guessed.
 * Evidence carried from another observation (its own fingerprint id differs) on a reduced identity - the evidence's or the
 * named fingerprint's - is the reduced-identity limitation.
 */
export function endoCockpitEvidenceVsFingerprintV0(
	evidence: { fingerprintId: string; identityDigest: string; confidence: string },
	named: { id: string; identity: { digest: string; confidence: string } | null },
): { identityDiffers: boolean | null; confidenceDiffers: boolean | null; reducedIdentity: boolean | null } {
	const carried = evidence.fingerprintId !== named.id;
	const reducedKnown = evidence.confidence === "reduced" || named.identity?.confidence === "reduced";
	return {
		identityDiffers: named.identity === null ? null : evidence.identityDigest !== named.identity.digest,
		confidenceDiffers: named.identity === null ? null : evidence.confidence !== named.identity.confidence,
		// Settled when the evidence itself is reduced, or when the named identity is known at all.
		reducedIdentity: !carried ? false : reducedKnown ? true : named.identity === null ? null : false,
	};
}
