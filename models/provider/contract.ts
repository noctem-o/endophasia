/**
 * Phase 12 — the neutral model-provider port (README "## Phase 12 — Operational substrate &
 * integration"): the seam between the runtime and a concrete model backend. A provider is
 * described by the protocol records in `protocol/provider.ts` — the request, the recorded
 * outcomes (response, stream, error), and the host's declarations (capabilities, health) —
 * and the port only routes those records. No wire format, transport, or HTTP concept leaks
 * into the port: implementations are adapters that translate between the neutral records and
 * a concrete backend, and the transport they use is injected by the host, never chosen here.
 *
 * The result of a call is a discriminated outcome — either the recorded success or the
 * recorded error — never a thrown provider failure: a failed call is itself a record
 * (with a retryable flag), because the caller records what happened, including the failure.
 * A broken transport contract (a 2xx body the backend claims is a completion but is not)
 * is a host-side programming error and throws TypeError instead.
 */

import type {
	EndoProviderCapabilitiesV0,
	EndoProviderErrorV0,
	EndoProviderHealthV0,
	EndoProviderRequestV0,
	EndoProviderResponseV0,
	EndoProviderStreamV0,
} from "../../protocol/provider.ts";

/** The outcome of one non-streaming call: the recorded response, or the recorded error. */
export type EndoProviderCompleteResultV0 =
	| { ok: true; response: EndoProviderResponseV0 }
	| { ok: false; error: EndoProviderErrorV0 };

/** The outcome of one streaming call: the recorded stream, or the recorded error. */
export type EndoProviderStreamResultV0 =
	| { ok: true; stream: EndoProviderStreamV0 }
	| { ok: false; error: EndoProviderErrorV0 };

/**
 * A model provider. `complete` and `stream` take the protocol request (one request is one
 * call; a retry is a new request with a new id) and return the recorded outcome — the
 * implementation measures its own call duration and mints the outcome record id. `capabilities`
 * is the host's static declaration for this provider (observational, never assumed); `health`
 * is one probe, and a latency it did not measure stays absent.
 */
export interface EndoModelProviderV0 {
	/** The provider name, opaque — the one recorded in the request and the declarations. */
	readonly provider: string;
	complete(request: EndoProviderRequestV0): Promise<EndoProviderCompleteResultV0>;
	stream(request: EndoProviderRequestV0): Promise<EndoProviderStreamResultV0>;
	capabilities(): EndoProviderCapabilitiesV0;
	health(): Promise<EndoProviderHealthV0>;
}
