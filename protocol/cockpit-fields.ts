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

import { ENDO_INTERVENTION_KINDS_V0 } from "./intervention.ts";
import { ENDO_LIFECYCLE_KINDS_V0, isEndoLifecycleKindV0 } from "./session-lifecycle.ts";

function freezeDeep<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) freezeDeep(item);
	}
	return value;
}

export type EndoCockpitFieldBasisV0 = "observed" | "reported" | "derived";
export type EndoCockpitFieldTypeV0 = "string" | "number" | "boolean";
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
		["fingerprintId", "fingerprintId", "observed", "string"],
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

/** The kinds whose `unavailable` list of `{ field, reason }` becomes dynamic `unavailable.<field>` presented fields. */
export const ENDO_COCKPIT_DECLARED_UNAVAILABLE_KINDS_V0: readonly string[] = freezeDeep([
	"lifecycle.session-started",
	"lifecycle.session-resumed",
]);

/** An opaque producer name is presented only in the shape Endophasia's own producers use. */
export function endoCockpitProducerAdmittedV0(producer: string): boolean {
	return ADMITTED_PRODUCER.test(producer);
}

/** An opaque runtime session reference is presented only in a shape Endophasia writes or a UUID. */
export function endoCockpitRuntimeSessionAdmittedV0(reference: string): boolean {
	return ADMITTED_RUNTIME_SESSION.some((shape) => shape.test(reference));
}

/** Whether a kind is one the producers record (or a lifecycle/intervention kind this version defines). */
export function endoCockpitKindRecognizedV0(kind: string): boolean {
	return ENDO_COCKPIT_RECOGNIZED_KINDS_V0.includes(kind);
}

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
	if (spec !== undefined) return { basis: spec[2], type: spec[3], nullable: spec[4] === true };
	if (kind === "harness.attached" && key === "runtimeSessionId")
		return { basis: "reported", type: "string", nullable: false, admitted: endoCockpitRuntimeSessionAdmittedV0 };
	if (ENDO_COCKPIT_DECLARED_UNAVAILABLE_KINDS_V0.includes(kind) && key.startsWith("unavailable."))
		return { basis: "reported", type: "string", nullable: false, dynamic: true };
	return null;
}

/** A kind the policy flags "unrecognized" by itself: not recorded by any producer, or named so, or an unknown lifecycle kind. */
export function endoCockpitKindUnrecognizedV0(kind: string): boolean {
	return (
		ENDO_COCKPIT_UNRECOGNIZED_KINDS_V0.includes(kind) ||
		!endoCockpitKindRecognizedV0(kind) ||
		(kind.startsWith("lifecycle.") && !isEndoLifecycleKindV0(kind))
	);
}
