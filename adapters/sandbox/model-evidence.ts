// EVAL-ISO-003 (docs/protected-model-access.md §9): what a model relay's recording shows, derived from the recording itself (the capture
// log and its blob store, under the attempt's digest key), never from the relay's or the controller's own account of it.
//
// The same derivation serves two readers: the controller, which writes the summary into an endo.protected-trial.v1 record, and the
// independent reader (endo experiment protected-report), which derives it again from the store and refuses a record that does not match,
// then judges every forwarded request's recorded body again under the run's declared policy. A matching digest shows the evidence is the
// one recorded; it is not proof against someone with the host account, who could rewrite both (docs/protected-experiments.md §8).

import { join } from "node:path";
import { loadEndoCassetteV0 } from "../../adapters/openai-proxy/cassette.ts";
import { GOVERNED_REFUSAL_ERROR_V0, TRANSFER_LIMIT_ERROR_V0 } from "../../adapters/openai-proxy/record.ts";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../../storage/blob-store.ts";
import { admitModelRequestV0, type EndoModelRelayPolicyV0 } from "./model-relay.ts";

/**
 * What became of one recorded exchange:
 * - `answered`: the model server's response was relayed to its end (any status);
 * - `client-disconnected`: the agent's side closed before the exchange ended (the agent's doing, or its end). With a status, it was
 *   forwarded (the model server answered); without one, it may have been (awaiting the answer) or not (queued behind another request
 *   on the same connection, never judged): the recording does not say which;
 * - `model-failed`: forwarded (or its connection to the model server attempted), and the model server's side failed;
 * - `transfer-bound`: forwarded, and ended by the relay at the policy's transfer bound, which the agent's own traffic reached (the agent's
 *   doing, as a refusal is; the model server did not fail);
 * - `refused`: not forwarded because of a governed refusal on its connection: the judge refused it, or a request ahead of it that the agent
 *   pipelined on the same connection (the agent's doing);
 * - `not-forwarded`: queued behind another request on a connection that ended before it was forwarded, never judged;
 * - `unended`: the recording has no end for it (an incomplete recording).
 */
export type EndoModelExchangeClassV0 =
	| "answered"
	| "client-disconnected"
	| "model-failed"
	| "transfer-bound"
	| "refused"
	| "not-forwarded"
	| "unended";

export const ENDO_MODEL_EXCHANGE_CLASSES_V0: readonly EndoModelExchangeClassV0[] = [
	"answered",
	"client-disconnected",
	"model-failed",
	"transfer-bound",
	"refused",
	"not-forwarded",
	"unended",
];

/** One recorded exchange, as a trial record summarizes it. */
export interface EndoModelExchangeSummaryV0 {
	exchange: number;
	method: string;
	path: string;
	/** The request's keyed digest (its value; the key is the attempt's). */
	requestSha256: string;
	status: number | null;
	class: EndoModelExchangeClassV0;
	/** Whether its request and response bodies verify against the blob store. */
	verified: boolean;
}

/**
 * Exchanges the recording shows forwarded for certain (so admitted by the judge): answered; failed by the model server; ended at the
 * transfer bound; or ended by the agent after the model server's answer began (a status).
 */
export const certainlyForwardedV0 = (e: Pick<EndoModelExchangeSummaryV0, "class" | "status">): boolean =>
	e.class === "answered" ||
	e.class === "model-failed" ||
	e.class === "transfer-bound" ||
	(e.class === "client-disconnected" && e.status !== null);
/** Exchanges that may or may not have been forwarded: ended by the agent before any answer (see `client-disconnected`). */
export const possiblyForwardedV0 = (e: Pick<EndoModelExchangeSummaryV0, "class" | "status">): boolean =>
	e.class === "client-disconnected" && e.status === null;

/** A successful model exchange: answered with a 2xx status, and verified. The only kind that counts toward a declared minimum. */
export const successfulExchangeV0 = (e: Pick<EndoModelExchangeSummaryV0, "class" | "status" | "verified">): boolean =>
	e.class === "answered" && e.verified && e.status !== null && e.status >= 200 && e.status < 300;

/** Derive the exchange summary from a recording. Throws when the recording does not load as one cassette under this key. */
export function summarizeModelRecordingV0(
	store: string,
	key: EndoDigestKeyV0,
): { keyId: string; exchanges: EndoModelExchangeSummaryV0[] } {
	const cassette = loadEndoCassetteV0(store, key);
	// The transport of each failed exchange is in its end event only (the cassette keeps the error text, not where it failed).
	const transport = new Map<number, string>();
	for (const event of cassette.events) {
		if (event.producer !== "capture:record" || event.kind !== "capture.exchange-ended") continue;
		const payload = event.payload as Record<string, unknown> | null;
		const t = payload?.transport as { phase?: unknown } | undefined;
		if (typeof payload?.exchange === "number" && typeof t?.phase === "string")
			transport.set(payload.exchange, t.phase);
	}
	const exchanges = [...cassette.exchanges]
		.sort((a, b) => a.exchange - b.exchange)
		.map((e): EndoModelExchangeSummaryV0 => {
			const r = e.response;
			const phase = transport.get(e.exchange);
			const cls: EndoModelExchangeClassV0 =
				r === null
					? "unended"
					: r.outcome === "complete"
						? "answered"
						: r.outcome === "client-disconnected"
							? "client-disconnected"
							: phase === "not-forwarded"
								? r.error === GOVERNED_REFUSAL_ERROR_V0
									? "refused"
									: "not-forwarded"
								: r.error === TRANSFER_LIMIT_ERROR_V0
									? "transfer-bound"
									: "model-failed";
			return {
				exchange: e.exchange,
				method: e.method,
				path: e.path,
				requestSha256: e.requestDigest.value,
				status: r?.status ?? null,
				class: cls,
				verified: e.truncated === null,
			};
		});
	return { keyId: cassette.keyId, exchanges };
}

/**
 * Every recorded exchange whose request the policy would refuse, judged again from the recorded body (decoded from the blob store under
 * its key) by the same judge the relay used. Empty when all of them are admissible. `only` limits it to some exchanges (by number).
 *
 * Moved from the EVAL-ISO-002 research driver (research/protected-eval/model-connected/trial.ts, which re-exports it), unchanged.
 */
export function exchangesOutsidePolicyV0(
	store: string,
	key: EndoDigestKeyV0,
	policy: EndoModelRelayPolicyV0,
	only?: ReadonlySet<number>,
): { exchange: number; reason: string }[] {
	const cassette = loadEndoCassetteV0(store, key);
	const blobs = createEndoBlobStoreV0(join(store, "capture"), key, { readOnly: true });
	const outside: { exchange: number; reason: string }[] = [];
	for (const e of cassette.exchanges) {
		if (only !== undefined && !only.has(e.exchange)) continue;
		let body: Uint8Array;
		try {
			body = blobs.get(e.requestBody.digest);
		} catch {
			outside.push({ exchange: e.exchange, reason: "body-unreadable" });
			continue;
		}
		// The relay's lifetime exchange bound (absent from policies recorded before it existed): an exchange past it was never admissible.
		if (only === undefined && policy.maxExchanges !== undefined && e.exchange > policy.maxExchanges) {
			outside.push({ exchange: e.exchange, reason: "exchanges" });
			continue;
		}
		const verdict = admitModelRequestV0(policy, { method: e.method, path: e.path, body });
		if (!verdict.admitted) outside.push({ exchange: e.exchange, reason: verdict.reason });
	}
	return outside;
}

/**
 * The independent reader's check of a model-connected attempt's recording against its record (null when it holds, else why not):
 * - the recording loads under the attempt's key, in the digest domain the record names;
 * - the record's exchange summary is exactly the one derived from the recording now;
 * - when the relay's counters were recorded, the judge's admitted count lies between the exchanges the recording shows certainly
 *   forwarded and those it shows possibly forwarded (two independent accounts of the same requests; the recording cannot tell a request
 *   an agent abandoned while it waited for the answer from one it abandoned in a queue);
 * - no more certainly forwarded requests than the policy's exchange bound;
 * - every certainly forwarded request, judged again from its recorded body under the declared policy, is one the policy admits. Others
 *   are not judged again: a refusal also ends what the agent pipelined behind it, and an abandoned queued request was never judged, so
 *   some are inadmissible without the relay having erred, and an agent must not be able to make its own record unreadable.
 */
export function verifyModelEvidenceV0(options: {
	store: string;
	key: EndoDigestKeyV0;
	policy: EndoModelRelayPolicyV0;
	recorded: { keyId: string | null; exchanges: readonly EndoModelExchangeSummaryV0[] };
	admitted: number | null;
}): string | null {
	let derived: ReturnType<typeof summarizeModelRecordingV0>;
	try {
		derived = summarizeModelRecordingV0(options.store, options.key);
	} catch (error) {
		// A recording with no exchange at all has nothing to load; the record must then say so too.
		if (options.recorded.exchanges.length === 0 && options.recorded.keyId === null) return null;
		return `the recording does not load: ${String((error as Error).message).slice(0, 160)}`;
	}
	if (derived.keyId !== options.recorded.keyId)
		return "the recording is in another digest domain than the record names";
	if (
		canonicalEndoJsonV0(derived.exchanges as unknown as Record<string, unknown>[]) !==
		canonicalEndoJsonV0(options.recorded.exchanges as unknown as Record<string, unknown>[])
	)
		return "the record's exchanges are not the ones the recording shows";
	const forwarded = derived.exchanges.filter(certainlyForwardedV0);
	const possibly = derived.exchanges.filter(possiblyForwardedV0).length;
	if (
		options.admitted !== null &&
		(options.admitted < forwarded.length || options.admitted > forwarded.length + possibly)
	)
		return `the relay admitted ${options.admitted} request(s), the recording shows ${forwarded.length} forwarded and ${possibly} possibly forwarded`;
	if (options.policy.maxExchanges !== undefined && forwarded.length > options.policy.maxExchanges)
		return "more requests were forwarded than the policy's exchange bound";
	const outside = exchangesOutsidePolicyV0(
		options.store,
		options.key,
		options.policy,
		new Set(forwarded.map((e) => e.exchange)),
	);
	if (outside.length > 0)
		return `forwarded requests the declared policy refuses: ${outside
			.slice(0, 8)
			.map((o) => `${o.exchange} (${o.reason})`)
			.join(", ")}`;
	return null;
}
