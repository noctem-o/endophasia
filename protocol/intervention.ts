// The intervention schema (`endo.intervention.v0`): STEER, QUEUE and STOP as explicit, authorized and verified
// interventions. Each step is its own record, an `endo.event.v0` whose payload this module defines, linked to the
// previous step by id (the event's `derivedFrom` and the payload's own reference):
//
//   observation? → interpretation? → proposal → authorization → request → acceptance | refusal
//                                                                       → consumption → consequence
//
// | Record (event kind)            | Source class        | What it is                                                     |
// | :----------------------------- | :------------------ | :------------------------------------------------------------- |
// | intervention.observation       | runtime-fact        | what the operator points at: recorded event ids, and a note     |
// | intervention.interpretation    | interpretation      | the operator's reading of an observation                       |
// | intervention.proposal          | policy-conclusion   | an operation (steer, queue, stop) with its message, for one     |
// |                                |                     | session and attachment; it carries its own digest              |
// | intervention.authorization     | authority-decision  | allow or deny, bound to the proposal's id and digest, the       |
// |                                |                     | session and the attachment                                     |
// | intervention.request           | runtime-fact        | Endophasia sent the operation to the runtime                   |
// | intervention.accepted          | runtime-fact        | the runtime's reply accepted it (Pi: a disposition)            |
// | intervention.refused           | runtime-fact        | Endophasia's gate or the runtime refused it, with the reason   |
// | intervention.consumed          | runtime-fact        | the message, by keyed digest, appeared in a later model request |
// |                                |                     | captured by the recording proxy (derived from that capture)    |
// | intervention.consequence       | evaluation-result   | acceptance, consumption and effect, kept apart                 |
//
// Three things are never conflated: **acceptance** is the runtime's reply; **consumption** is proxy evidence that the
// model was sent the message; **effect** is what the trajectory did after that point. Consumption is recorded only when
// the capture shows it; otherwise the consequence says it was not observed, and why.
//
// v0 proposals come only from the operator through the CLI (`origin: "operator-cli"`, or `"operator-scenario"` when a
// recorded scenario the operator wrote carries them). There are no model-originated proposals. Authorization is the
// local operator's confirmation of the exact proposal digest; nothing is allowed by default. An external authority
// provider (for example Deadbolt) is a documented seam (`runtime/contracts/intervention.ts`), not wired.

import { isEndoIdentifierV0 } from "./identity.ts";
import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";

export const ENDO_INTERVENTION_SCHEMA_V0 = "endo.intervention.v0";

export type EndoInterventionOperationV0 = "steer" | "queue" | "stop";
export const ENDO_INTERVENTION_OPERATIONS_V0: readonly EndoInterventionOperationV0[] = ["steer", "queue", "stop"];

export type EndoInterventionOriginV0 = "operator-cli" | "operator-scenario";

/** A message, referenced by keyed digest (the text is kept outside canonical evidence, addressed by that digest). */
export interface EndoInterventionMessageRefV0 {
	digest: { algorithm: "hmac-sha256"; keyId: string; value: string };
	bytes: number;
}

/** Where in the model traffic an operation was sent: the proxy's delivery point (exchange, chunks relayed). */
export interface EndoInterventionPointV0 {
	exchange: number;
	chunks: number;
}

export interface EndoInterventionObservationV0 {
	schemaVersion: typeof ENDO_INTERVENTION_SCHEMA_V0;
	observationId: string;
	session: string;
	/** Recorded event ids the observation points at. */
	about: string[];
	note: EndoInterventionMessageRefV0 | null;
}

export interface EndoInterventionInterpretationV0 {
	schemaVersion: typeof ENDO_INTERVENTION_SCHEMA_V0;
	interpretationId: string;
	session: string;
	observationId: string;
	statement: EndoInterventionMessageRefV0;
}

/** The content a proposal's digest covers (everything but the id and the digest itself). */
export interface EndoInterventionProposalContentV0 {
	schemaVersion: typeof ENDO_INTERVENTION_SCHEMA_V0;
	origin: EndoInterventionOriginV0;
	operation: EndoInterventionOperationV0;
	/** Required for steer and queue; null for stop. */
	message: EndoInterventionMessageRefV0 | null;
	/** `endo.session.*` */
	session: string;
	attachment: string;
	basis: { observationId: string | null; interpretationId: string | null };
	/** A caller-chosen nonce, so the same operation can be proposed twice as two proposals. */
	nonce: string;
}

export interface EndoInterventionProposalV0 extends EndoInterventionProposalContentV0 {
	proposalId: string;
	/** sha256 of the canonical JSON of the content. */
	proposalDigest: string;
}

export type EndoInterventionAuthorityV0 =
	| { kind: "local-operator"; confirmation: "digest-confirmed" | "scenario" }
	| { kind: "external"; provider: string };

export interface EndoInterventionAuthorizationV0 {
	schemaVersion: typeof ENDO_INTERVENTION_SCHEMA_V0;
	authorizationId: string;
	proposalId: string;
	proposalDigest: string;
	session: string;
	attachment: string;
	authority: EndoInterventionAuthorityV0;
	decision: "allow" | "deny";
	reason: string | null;
}

export interface EndoInterventionRequestV0 {
	schemaVersion: typeof ENDO_INTERVENTION_SCHEMA_V0;
	requestId: string;
	proposalId: string;
	authorizationId: string;
	operation: EndoInterventionOperationV0;
	/** The runtime capability the operation needs (Pi: steering.steer, steering.follow-up, steering.stop). */
	capability: string;
	/** The proxy's delivery point when the request was sent, when a recording proxy was attached. */
	at: EndoInterventionPointV0 | null;
}

export interface EndoInterventionAcceptedV0 {
	schemaVersion: typeof ENDO_INTERVENTION_SCHEMA_V0;
	requestId: string;
	/** The runtime's reply (Pi: the disposition, "queued" or "handled"; stop has none). */
	disposition: string | null;
}

/** Why an intervention was refused, before or by the runtime. */
export type EndoInterventionRefusalReasonV0 =
	| "not-authorized"
	| "authorization-denied"
	| "authorization-for-another-proposal"
	| "authorization-for-another-session"
	| "authorization-for-another-attachment"
	| "authorization-expired"
	| "proposal-tampered"
	| "proposal-for-another-session"
	| "capability-unavailable"
	| "session-ended"
	| "no-active-run"
	| "runtime-refused"
	| "runtime-failed";

export const ENDO_INTERVENTION_REFUSAL_REASONS_V0: readonly EndoInterventionRefusalReasonV0[] = [
	"not-authorized",
	"authorization-denied",
	"authorization-for-another-proposal",
	"authorization-for-another-session",
	"authorization-for-another-attachment",
	"authorization-expired",
	"proposal-tampered",
	"proposal-for-another-session",
	"capability-unavailable",
	"session-ended",
	"no-active-run",
	"runtime-refused",
	"runtime-failed",
];

export interface EndoInterventionRefusedV0 {
	schemaVersion: typeof ENDO_INTERVENTION_SCHEMA_V0;
	proposalId: string;
	/** Null when the gate refused before any request was sent. */
	requestId: string | null;
	reason: EndoInterventionRefusalReasonV0;
	detail: string;
}

export interface EndoInterventionConsumedV0 {
	schemaVersion: typeof ENDO_INTERVENTION_SCHEMA_V0;
	requestId: string;
	/** The captured exchange (1-based, in capture order) whose request first carried the message. */
	exchange: number;
	/** The capture event the evidence is (`capture.request`). */
	captureEvent: string;
	/** The message's keyed digest, as found in that request (equal to the proposal's). */
	message: EndoInterventionMessageRefV0;
}

export type EndoInterventionConsumptionV0 =
	| { status: "observed"; exchange: number; captureEvent: string }
	| { status: "not-observed"; reason: string }
	| { status: "not-applicable"; reason: string };

export interface EndoInterventionConsequenceV0 {
	schemaVersion: typeof ENDO_INTERVENTION_SCHEMA_V0;
	requestId: string;
	/**
	 * `pending`: Pi had not replied when the consequence was recorded (an abort is answered only once the run is idle). The
	 * acceptance record, if it comes, follows the consequence.
	 */
	acceptance:
		| { status: "accepted"; disposition: string | null }
		| { status: "refused"; reason: string }
		| { status: "pending"; reason: string };
	consumption: EndoInterventionConsumptionV0;
	/**
	 * What the trajectory did after the request, as observed in the store: the runs that ended after it and how they
	 * ended. Never a judgement that the intervention helped.
	 */
	effect: {
		runsEndedAfter: number;
		lastRunEnding: string | null;
		turnsAfter: number;
		toolCallsAfter: number;
	};
}

/** Event kinds and their source classes. */
export const ENDO_INTERVENTION_KINDS_V0 = {
	"intervention.observation": "runtime-fact",
	"intervention.interpretation": "interpretation",
	"intervention.proposal": "policy-conclusion",
	"intervention.authorization": "authority-decision",
	"intervention.request": "runtime-fact",
	"intervention.accepted": "runtime-fact",
	"intervention.refused": "runtime-fact",
	"intervention.consumed": "runtime-fact",
	"intervention.consequence": "evaluation-result",
} as const;

export type EndoInterventionKindV0 = keyof typeof ENDO_INTERVENTION_KINDS_V0;

const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9._-]{1,128}$/;

function messageRef(value: unknown): value is EndoInterventionMessageRefV0 {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return false;
	const v = value as Record<string, unknown>;
	if (Object.keys(v).sort().join() !== "bytes,digest") return false;
	const d = v.digest as Record<string, unknown> | null;
	return (
		typeof v.bytes === "number" &&
		Number.isInteger(v.bytes) &&
		v.bytes >= 1 &&
		v.bytes <= 16_384 &&
		typeof d === "object" &&
		d !== null &&
		d.algorithm === "hmac-sha256" &&
		typeof d.keyId === "string" &&
		typeof d.value === "string" &&
		HEX64.test(d.value) &&
		Object.keys(d).length === 3
	);
}

/** Why a proposal's content is malformed, or null. */
export function endoInterventionProposalContentProblemV0(value: unknown): string | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return "not an object";
	const v = value as Record<string, unknown>;
	const keys = ["attachment", "basis", "message", "nonce", "operation", "origin", "schemaVersion", "session"];
	for (const key of Object.keys(v)) if (!keys.includes(key)) return `unknown field ${key}`;
	if (v.schemaVersion !== ENDO_INTERVENTION_SCHEMA_V0) return "wrong schemaVersion";
	if (v.origin !== "operator-cli" && v.origin !== "operator-scenario")
		return "origin must be operator-cli or operator-scenario (v0 has no model-originated proposals)";
	if (!ENDO_INTERVENTION_OPERATIONS_V0.includes(v.operation as EndoInterventionOperationV0))
		return "operation must be steer, queue or stop";
	if (v.operation === "stop" ? v.message !== null : !messageRef(v.message))
		return v.operation === "stop" ? "stop carries no message" : "steer and queue need a message reference";
	if (typeof v.session !== "string" || !isEndoIdentifierV0(v.session, "session"))
		return "session must be endo.session.*";
	if (typeof v.attachment !== "string" || v.attachment.length === 0 || v.attachment.length > 128)
		return "attachment is required";
	const basis = v.basis as Record<string, unknown> | null;
	if (
		typeof basis !== "object" ||
		basis === null ||
		Object.keys(basis).sort().join() !== "interpretationId,observationId" ||
		![basis.observationId, basis.interpretationId].every(
			(id) => id === null || (typeof id === "string" && isEndoIdentifierV0(id, "evidence")),
		)
	)
		return "basis must name an observation and an interpretation id, or null";
	if (typeof v.nonce !== "string" || !NONCE.test(v.nonce)) return "nonce must be 1-128 of [A-Za-z0-9._-]";
	return null;
}

/** Validate a record's payload by its kind. Returns null when valid, or the problem. */
export function endoInterventionPayloadProblemV0(kind: string, payload: JsonValueV0): string | null {
	if (!(kind in ENDO_INTERVENTION_KINDS_V0)) return `unknown intervention kind ${kind}`;
	if (typeof payload !== "object" || payload === null || !isPlainJsonObjectV0(payload)) return "not an object";
	const p = payload as Record<string, unknown>;
	if (p.schemaVersion !== ENDO_INTERVENTION_SCHEMA_V0) return "wrong schemaVersion";
	const id = (field: string) => typeof p[field] === "string" && isEndoIdentifierV0(p[field] as string, "evidence");
	switch (kind as EndoInterventionKindV0) {
		case "intervention.proposal": {
			const { proposalId: _proposalId, proposalDigest, ...content } = p;
			if (!id("proposalId")) return "proposalId must be endo.evidence.*";
			if (typeof proposalDigest !== "string" || !HEX64.test(proposalDigest))
				return "proposalDigest must be sha256 hex";
			return endoInterventionProposalContentProblemV0(content);
		}
		case "intervention.authorization":
			if (!id("authorizationId") || !id("proposalId")) return "authorizationId and proposalId are required";
			if (p.decision !== "allow" && p.decision !== "deny") return "decision must be allow or deny";
			if (typeof p.proposalDigest !== "string" || !HEX64.test(p.proposalDigest)) return "proposalDigest is required";
			return null;
		case "intervention.request":
			return id("requestId") && id("proposalId") && id("authorizationId") ? null : "request ids are required";
		case "intervention.accepted":
		case "intervention.consequence":
			return id("requestId") ? null : "requestId is required";
		case "intervention.refused":
			if (!id("proposalId")) return "proposalId is required";
			return ENDO_INTERVENTION_REFUSAL_REASONS_V0.includes(p.reason as EndoInterventionRefusalReasonV0)
				? null
				: "unknown refusal reason";
		case "intervention.consumed":
			return id("requestId") && typeof p.exchange === "number" && messageRef(p.message)
				? null
				: "requestId, exchange and message are required";
		case "intervention.observation":
			return id("observationId") ? null : "observationId is required";
		case "intervention.interpretation":
			return id("interpretationId") && id("observationId") ? null : "interpretation ids are required";
	}
}
