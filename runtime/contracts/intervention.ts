// The intervention contract, pure (protocol/intervention.ts): proposal digests and ids, the gate an intervention must
// pass before anything is sent to a runtime, the authority seam, and how consumption is found in captured requests.
//
// The gate denies by default. In order, it refuses:
//   - no authorization, or a deny;
//   - an authorization for another proposal, or for another digest of this one;
//   - a proposal whose recorded content, or whose message, no longer matches its digest (tampered);
//   - a proposal or authorization bound to another session or attachment;
//   - an operation whose runtime capability current evidence does not admit (UNAVAILABLE, with the reason);
//   - a session that has ended, and a run that is not active.
//
// Authority. v0 has one provider, the local operator: it allows a proposal only when the operator confirms that
// proposal's exact digest. `EndoInterventionAuthorityProviderV0` is the seam an external authority (for example
// Deadbolt, see trust records) would implement; nothing wires one yet.

import {
	ENDO_INTERVENTION_SCHEMA_V0,
	type EndoInterventionAuthorizationV0,
	type EndoInterventionMessageRefV0,
	type EndoInterventionOperationV0,
	type EndoInterventionProposalContentV0,
	type EndoInterventionProposalV0,
	type EndoInterventionRefusalReasonV0,
	endoInterventionProposalContentProblemV0,
} from "../../protocol/intervention.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";
import type { EndoDigestKeyV0 } from "./keyed-digest.ts";

/** sha256 of the proposal content's canonical JSON. */
export function endoInterventionProposalDigestV0(content: EndoInterventionProposalContentV0): string {
	const problem = endoInterventionProposalContentProblemV0(content);
	if (problem !== null) throw new TypeError(`malformed proposal: ${problem}`);
	return sha256HexV0(canonicalEndoJsonV0(content));
}

/** A proposal from its content: the id is derived from the digest. */
export function endoInterventionProposalV0(content: EndoInterventionProposalContentV0): EndoInterventionProposalV0 {
	const proposalDigest = endoInterventionProposalDigestV0(content);
	return { ...content, proposalId: `endo.evidence.intervention.proposal.${proposalDigest}`, proposalDigest };
}

/** The content a recorded proposal's digest covers. */
export function endoInterventionProposalContentV0(
	proposal: EndoInterventionProposalV0,
): EndoInterventionProposalContentV0 {
	const { proposalId: _id, proposalDigest: _digest, ...content } = proposal;
	return content;
}

/** A message reference: the keyed digest of the message's UTF-8 bytes, and its length. */
export function endoInterventionMessageRefV0(key: EndoDigestKeyV0, text: string): EndoInterventionMessageRefV0 {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length === 0 || bytes.length > 16_384) throw new TypeError("a message is 1 to 16384 bytes");
	return { digest: key.digestBytes(bytes) as EndoInterventionMessageRefV0["digest"], bytes: bytes.length };
}

/** The runtime capability each operation needs, for Pi (adapters/pi/capabilities.ts). */
export const PI_INTERVENTION_CAPABILITIES_V0: Readonly<Record<EndoInterventionOperationV0, string>> = {
	steer: "steering.steer",
	queue: "steering.follow-up",
	stop: "steering.stop",
};

/** An authority that decides on a proposal. The local operator is the only v0 implementation. */
export interface EndoInterventionAuthorityProviderV0 {
	readonly authority: EndoInterventionAuthorizationV0["authority"];
	decide(proposal: EndoInterventionProposalV0): { decision: "allow" | "deny"; reason: string | null };
}

/**
 * The local operator: allows only when `confirmedDigest` is exactly the proposal's digest. Anything else, including
 * no confirmation, is a deny.
 */
export function localOperatorAuthorityV0(
	confirmedDigest: string | null,
	confirmation: "digest-confirmed" | "scenario" = "digest-confirmed",
): EndoInterventionAuthorityProviderV0 {
	return {
		authority: { kind: "local-operator", confirmation },
		decide(proposal) {
			if (confirmedDigest === null) return { decision: "deny", reason: "the operator confirmed no digest" };
			if (confirmedDigest !== proposal.proposalDigest)
				return { decision: "deny", reason: "the confirmed digest is not this proposal's digest" };
			return { decision: "allow", reason: null };
		},
	};
}

/** Build the authorization record a provider's decision makes. */
export function endoInterventionAuthorizationV0(
	proposal: EndoInterventionProposalV0,
	provider: EndoInterventionAuthorityProviderV0,
	nonce: string,
): EndoInterventionAuthorizationV0 {
	const { decision, reason } = provider.decide(proposal);
	const body = {
		proposalId: proposal.proposalId,
		proposalDigest: proposal.proposalDigest,
		session: proposal.session,
		attachment: proposal.attachment,
		authority: provider.authority,
		decision,
		reason,
	};
	return {
		schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
		authorizationId: `endo.evidence.intervention.authorization.${sha256HexV0(canonicalEndoJsonV0({ ...body, nonce }))}`,
		...body,
	};
}

export interface EndoInterventionGateInputV0 {
	proposal: EndoInterventionProposalV0;
	authorization: EndoInterventionAuthorizationV0 | null;
	/** Whether the stored message still digests to the proposal's reference (null for stop). */
	messageVerified: boolean | null;
	currentSession: string;
	currentAttachment: string;
	capability: { admitted: true } | { admitted: false; reason: string };
	sessionLive: boolean;
	runActive: boolean;
}

export type EndoInterventionGateV0 =
	| { ok: true }
	| { ok: false; reason: EndoInterventionRefusalReasonV0; detail: string };

/** The gate, in the order the module comment gives. */
export function endoInterventionGateV0(input: EndoInterventionGateInputV0): EndoInterventionGateV0 {
	const { proposal, authorization } = input;
	const refuse = (reason: EndoInterventionRefusalReasonV0, detail: string): EndoInterventionGateV0 => ({
		ok: false,
		reason,
		detail,
	});
	if (authorization === null) return refuse("not-authorized", "no authorization was given for this proposal");
	if (authorization.decision !== "allow")
		return refuse("authorization-denied", authorization.reason ?? "the authority denied the proposal");
	if (authorization.proposalId !== proposal.proposalId)
		return refuse("authorization-for-another-proposal", `the authorization is for ${authorization.proposalId}`);
	let recomputed: string;
	try {
		recomputed = endoInterventionProposalDigestV0(endoInterventionProposalContentV0(proposal));
	} catch (error) {
		return refuse("proposal-tampered", (error as Error).message);
	}
	if (
		recomputed !== proposal.proposalDigest ||
		`endo.evidence.intervention.proposal.${recomputed}` !== proposal.proposalId
	)
		return refuse("proposal-tampered", "the proposal's content no longer matches its digest");
	if (authorization.proposalDigest !== recomputed)
		return refuse("proposal-tampered", "the authorization was given for another digest of this proposal");
	if (input.messageVerified === false)
		return refuse("proposal-tampered", "the stored message no longer matches the proposal's message digest");
	if (authorization.session !== input.currentSession)
		return refuse("authorization-for-another-session", `the authorization is bound to ${authorization.session}`);
	if (proposal.session !== input.currentSession)
		return refuse("proposal-for-another-session", `the proposal is bound to ${proposal.session}`);
	if (authorization.attachment !== input.currentAttachment || proposal.attachment !== input.currentAttachment)
		return refuse("authorization-for-another-attachment", `bound to attachment ${authorization.attachment}`);
	if (!input.capability.admitted) return refuse("capability-unavailable", input.capability.reason);
	if (!input.sessionLive) return refuse("session-ended", "the session has ended; nothing is running to receive it");
	if (!input.runActive) return refuse("no-active-run", `no run is active: ${proposal.operation} needs one`);
	return { ok: true };
}

/** A captured model request, in capture order. */
export interface EndoCapturedRequestV0 {
	/** 1-based, in capture order. */
	exchange: number;
	/** The `capture.request` event's id. */
	captureEvent: string;
	body: unknown;
}

/** The text of every user message in an OpenAI-compatible chat request body. */
export function endoUserMessageTextsV0(body: unknown): string[] {
	const messages =
		typeof body === "object" && body !== null && Array.isArray((body as { messages?: unknown }).messages)
			? ((body as { messages: unknown[] }).messages as Record<string, unknown>[])
			: [];
	return messages
		.filter((message) => message?.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? (message.content as { type?: string; text?: unknown }[])
							.filter((part) => part?.type === "text" && typeof part.text === "string")
							.map((part) => part.text as string)
							.join("")
					: "",
		);
}

/**
 * The first captured request, from exchange `fromExchange` on, that carries a user message whose keyed digest is the
 * proposal's message digest. Null when none does: consumption is then not observed.
 */
export function endoFindConsumptionV0(
	requests: readonly EndoCapturedRequestV0[],
	message: EndoInterventionMessageRefV0,
	key: EndoDigestKeyV0,
	fromExchange: number,
): EndoCapturedRequestV0 | null {
	if (message.digest.keyId !== key.keyId) return null;
	for (const request of requests) {
		if (request.exchange < fromExchange) continue;
		for (const text of endoUserMessageTextsV0(request.body))
			if (key.digestBytes(Buffer.from(text, "utf8")).value === message.digest.value) return request;
	}
	return null;
}
