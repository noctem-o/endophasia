// The intervention contract, pure (protocol/intervention.ts): proposal digests and ids, the gate an intervention must
// pass before anything is sent to a runtime, the authority seam, and how consumption is found in captured requests.
//
// The gate denies by default. In order, it refuses:
//   - no authorization, or a deny;
//   - an authorization for another proposal, or for another digest of this one;
//   - a proposal whose recorded content, or whose message, no longer matches its digest (tampered);
//   - a proposal or authorization bound to another session or attachment;
//   - an authorization older than the oldest accepted, or dated in the future (it is for a decision made now);
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
	confirmation: "digest-confirmed" | "terminal-phrase" | "scenario" = "digest-confirmed",
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

/** How far in the future an authorization's recording time may be (clock skew), in ms. */
export const ENDO_INTERVENTION_CLOCK_SKEW_MS_V0 = 60_000;
/** The oldest authorization the desk accepts by default, in ms. */
export const ENDO_INTERVENTION_AUTHORIZATION_MAX_AGE_MS_V0 = 15 * 60_000;

export interface EndoInterventionGateInputV0 {
	proposal: EndoInterventionProposalV0;
	authorization: EndoInterventionAuthorizationV0 | null;
	/**
	 * How old the authorization record is (ms, by its recording time) and the oldest the gate accepts. An authorization
	 * is for a decision made now, not a standing permission: without both, no age is checked.
	 */
	authorizationAgeMs?: number;
	authorizationMaxAgeMs?: number;
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
	if (input.authorizationAgeMs !== undefined && input.authorizationMaxAgeMs !== undefined) {
		if (input.authorizationAgeMs > input.authorizationMaxAgeMs)
			return refuse(
				"authorization-expired",
				`the authorization is ${Math.round(input.authorizationAgeMs / 1000)} s old; the oldest accepted is ${Math.round(input.authorizationMaxAgeMs / 1000)} s`,
			);
		if (input.authorizationAgeMs < -ENDO_INTERVENTION_CLOCK_SKEW_MS_V0)
			return refuse("authorization-expired", "the authorization is dated in the future");
	}
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
	/** When the proxy recorded the request, ISO-8601 UTC. */
	at: string;
	body: unknown;
}

/**
 * Where the desk reads the recording proxy's capture from: the captured model requests of the session store, in
 * capture order, or null when the store holds no proxy capture. Supplied by the caller (cli/intervention-capture.ts),
 * so the Pi adapter depends on no proxy code.
 */
export interface EndoInterventionCaptureSourceV0 {
	requests(): readonly EndoCapturedRequestV0[] | null;
	/**
	 * Optional bounded reader: the capture's INDEX as it stands now, with bodies read one at a time on demand. A source that has it lets
	 * the desk scan a long capture in slices instead of loading every body at once. Null when the store holds no proxy capture. Throws
	 * when the capture cannot be indexed within the source's own limit (the desk then reports the check as incomplete, never as a negative).
	 * `maxIndexBytes` overrides that limit: the closing record, which has no responsiveness to protect, passes `Infinity`, so a long session's
	 * close-time consumption is read as whole as it always was.
	 */
	open?(options?: { maxIndexBytes?: number }): EndoCaptureSnapshotV0 | null;
}

/** One captured request without its body: what the scan needs to plan its work before it reads anything. */
export interface EndoCaptureIndexEntryV0 {
	exchange: number;
	captureEvent: string;
	at: string;
	/** The body's recorded length in bytes (0 when the source does not know it). */
	bodyBytes: number;
}

/** The capture as it stood when it was opened: later growth is not in it, and a later check opens a fresh one. */
export interface EndoCaptureSnapshotV0 {
	readonly entries: readonly EndoCaptureIndexEntryV0[];
	/** One body, verified. Throws when it is missing, does not verify, or is not JSON. */
	body(entry: EndoCaptureIndexEntryV0): unknown;
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

/** How many user messages in a request carry the message's keyed digest. */
function endoMessageOccurrencesV0(
	request: { body: unknown },
	message: EndoInterventionMessageRefV0,
	key: EndoDigestKeyV0,
): number {
	return endoUserMessageTextsV0(request.body).filter(
		(text) => key.digestBytes(Buffer.from(text, "utf8")).value === message.digest.value,
	).length;
}

/**
 * The first captured request, from exchange `fromExchange` on, that carries the message **one more time than the last
 * request before it did**. Every request resends the whole conversation, so a message whose text is already in the
 * history (an operator steering with the words of the original prompt, or with an earlier steer's) is in every later
 * request whether or not Pi delivered it: presence is not consumption, an increase is. Null when no request shows an
 * increase: consumption is then not observed.
 */
export function endoFindConsumptionV0(
	requests: readonly EndoCapturedRequestV0[],
	message: EndoInterventionMessageRefV0,
	key: EndoDigestKeyV0,
	fromExchange: number,
): EndoCapturedRequestV0 | null {
	if (message.digest.keyId !== key.keyId) return null;
	const ordered = [...requests].sort((a, b) => a.exchange - b.exchange);
	const before = ordered.filter((request) => request.exchange < fromExchange).at(-1);
	const baseline = before === undefined ? 0 : endoMessageOccurrencesV0(before, message, key);
	for (const request of ordered)
		if (request.exchange >= fromExchange && endoMessageOccurrencesV0(request, message, key) > baseline)
			return request;
	return null;
}

// --- the same rule, in slices -----------------------------------------------------------------------------------------------
//
// `endoFindConsumptionV0` needs every request in memory at once. The workbench cannot afford that on a long capture, so this is the SAME
// rule as a resumable scan over an index: the baseline is the message's occurrence count in the last request before `from`, and the
// answer is the first request from `from` on whose count is higher. Order is capture order (by exchange). A scan keeps its place, so
// a check that stopped (a work budget, a closing session) is resumed, not restarted, and total work stays linear in the capture.

/** The place a consumption scan has reached. Plain data: it holds no body and no message text. */
export interface EndoConsumptionScanV0 {
	/** The first exchange that may carry the message; null until the capture shows one. */
	from: number | null;
	/** The message's occurrence count in the request before `from`; null until that request has been read. */
	baseline: number | null;
	/** The exchange the baseline was read from (null: there was none before `from` in the capture then). A newer one replaces it. */
	baselineExchange: number | null;
	/** Exchanges to be tried again, in order, before the scan goes on forward: lost bodies, and requests that were recorded late. */
	retry: number[];
	/** The next exchange to examine. */
	next: number;
	/** The exchanges from `from` up to `next` that the scan has examined. A request recorded late, below `next`, is not among them. */
	seen: number[];
	/** Work done so far, over every slice. */
	scanned: { requests: number; bytes: number };
	/** Exchanges whose body could not be read, and exchanges whose body is over the per-body limit. A scan with any is never a negative. */
	unreadable: number[];
	tooLarge: number[];
}

export const endoNewConsumptionScanV0 = (): EndoConsumptionScanV0 => ({
	from: null,
	baseline: null,
	baselineExchange: null,
	retry: [],
	next: 0,
	seen: [],
	scanned: { requests: 0, bytes: 0 },
	unreadable: [],
	tooLarge: [],
});

export interface EndoConsumptionSliceLimitsV0 {
	/** Stop starting new bodies once this many body bytes were read in this slice (one body may overshoot, up to `maxBodyBytes`). */
	maxBytes: number;
	maxRequests: number;
	/** A body longer than this is not read: it is recorded as too large and the scan goes on. */
	maxBodyBytes: number;
}

export type EndoConsumptionSliceV0 =
	| { kind: "found"; exchange: number; captureEvent: string }
	| { kind: "more" }
	| { kind: "end"; requests: number; startedAt: number | null };

/**
 * Run one slice. `from` is supplied by the caller (it depends on the request's own record, which this module does not know); a scan with
 * no `from` yet reports `end` with `startedAt: null`. Every body read is verified by the source; one that fails is counted, not skipped
 * silently: the caller must not turn a scan with unreadable or oversized bodies into "not observed".
 */
export function endoSliceConsumptionV0(
	scan: EndoConsumptionScanV0,
	snapshot: EndoCaptureSnapshotV0,
	from: number | null,
	message: EndoInterventionMessageRefV0,
	key: EndoDigestKeyV0,
	limits: EndoConsumptionSliceLimitsV0,
): EndoConsumptionSliceV0 {
	const entries = [...snapshot.entries].sort((a, b) => a.exchange - b.exchange);
	if (message.digest.keyId !== key.keyId) return { kind: "end", requests: entries.length, startedAt: from };
	if (from === null || !Number.isFinite(from)) return { kind: "end", requests: entries.length, startedAt: null };
	let bytes = 0;
	let requests = 0;
	const read = (entry: EndoCaptureIndexEntryV0): { body: unknown } | null => {
		scan.scanned.requests += 1;
		scan.scanned.bytes += entry.bodyBytes;
		requests += 1;
		bytes += entry.bodyBytes;
		const lose = (list: number[]): null => {
			if (!list.includes(entry.exchange)) list.push(entry.exchange);
			return null;
		};
		if (entry.bodyBytes > limits.maxBodyBytes) return lose(scan.tooLarge);
		try {
			const body = snapshot.body(entry);
			// Read now: no longer lost.
			scan.unreadable = scan.unreadable.filter((e) => e !== entry.exchange);
			scan.tooLarge = scan.tooLarge.filter((e) => e !== entry.exchange);
			return { body };
		} catch {
			return lose(scan.unreadable);
		}
	};
	if (scan.from !== from) {
		scan.from = from;
		scan.baseline = null;
		scan.baselineExchange = null;
		scan.retry = [];
		scan.next = from;
	}
	// The baseline is the request just before `from` in THIS snapshot. A capture that has grown since the baseline was read may now hold
	// a newer one (its writes had not caught up when the scan first looked), and what was judged against the old baseline is judged again.
	const before = entries.filter((entry) => entry.exchange < from).at(-1);
	const beforeExchange = before?.exchange ?? null;
	if (scan.baseline === null || scan.baselineExchange !== beforeExchange) {
		if (scan.baseline !== null) {
			scan.next = from;
			scan.retry = [];
		}
		scan.baselineExchange = beforeExchange;
		if (before === undefined) scan.baseline = 0;
		else {
			const got = read(before);
			// With no baseline there is nothing to compare against: Infinity means no later request can be called an increase, and the
			// unreadable record makes the scan's answer incomplete rather than negative.
			scan.baseline = got === null ? Number.POSITIVE_INFINITY : endoMessageOccurrencesV0(got, message, key);
		}
	}
	// Only exchanges from the delivery point on can be the answer. A body that failed while it was an earlier baseline, and has been
	// replaced by a newer one, is obsolete: it must not be retried and read as a finding, nor keep the scan incomplete. The CURRENT
	// baseline's failure stays, because it is what makes the answer incomplete.
	const relevant = (exchange: number): boolean => exchange >= from || exchange === scan.baselineExchange;
	scan.retry = scan.retry.filter(relevant);
	scan.unreadable = scan.unreadable.filter(relevant);
	scan.tooLarge = scan.tooLarge.filter(relevant);
	if (scan.baseline === Number.POSITIVE_INFINITY) return { kind: "end", requests: entries.length, startedAt: from };
	if (scan.next <= from) scan.seen = []; // a scan that has not moved forward has examined nothing
	// Concurrent proxy connections can finish recording out of exchange order, so a request below the forward place may appear only now.
	// It was never examined, and the forward scan will not come back to it: it joins the retry queue, which is tried first and in order.
	const seen = new Set(scan.seen);
	const late = entries.filter((e) => e.exchange >= from && e.exchange < scan.next && !seen.has(e.exchange));
	if (late.length > 0) {
		for (const entry of late) scan.seen.push(entry.exchange);
		scan.retry = [...new Set([...scan.retry, ...late.map((e) => e.exchange)])].sort((a, b) => a - b);
	}
	// Lost bodies from an earlier check are tried again FIRST, in order: they precede the forward place, so an increase among them is the
	// earliest one, as `endoFindConsumptionV0` would find it. The forward place is kept, not reset.
	while (scan.retry.length > 0) {
		if (requests >= limits.maxRequests || (requests > 0 && bytes >= limits.maxBytes)) return { kind: "more" };
		const exchange = scan.retry.shift()!;
		const entry = entries.find((e) => e.exchange === exchange);
		if (entry === undefined || exchange < from) continue;
		const got = read(entry);
		if (got !== null && endoMessageOccurrencesV0(got, message, key) > scan.baseline)
			return { kind: "found", exchange: entry.exchange, captureEvent: entry.captureEvent };
	}
	for (const entry of entries) {
		if (entry.exchange < scan.next) continue;
		if (requests >= limits.maxRequests || (requests > 0 && bytes >= limits.maxBytes)) return { kind: "more" };
		const got = read(entry);
		scan.next = entry.exchange + 1;
		scan.seen.push(entry.exchange);
		if (got !== null && endoMessageOccurrencesV0(got, message, key) > scan.baseline)
			return { kind: "found", exchange: entry.exchange, captureEvent: entry.captureEvent };
	}
	return { kind: "end", requests: entries.length, startedAt: from };
}
