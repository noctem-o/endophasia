// Explicit ACP version selection across the two clients. Versions stay separate at the adapter boundary: client.ts speaks
// v1 only, client-v2.ts speaks v2 only, and neither is taught about the other. This is the one place that knows both,
// and it does a single thing: offer v2 first, and, only when the caller opted in and the agent answered exactly
// protocolVersion 1, attach with the v1 client instead.
//
// Falling back is not a continuation of the v2 connection. The v2 client has sent its initialize and the agent answered
// it, so the agent is closed and launched AGAIN for the v1 attachment: the agent sees a v2 initialize first, then a
// fresh v1 one, and any side effect of being launched happens twice. (ACP's own model would continue on the same
// connection; the SDK's v2 client cannot, and v1 must stay byte-for-byte what it was.) Evidence of both attempts goes to
// each client's own `onEvent`, so the v2 attempt's `unsupported-protocol-version` fault precedes the v1 attachment.
//
// Fail closed: any other negotiation outcome (an answer of neither 1 nor 2, an incoherent answer, a refusal, a vanished
// agent) is thrown, never retried as v1. A fallback is also refused when the caller asked for history replay, which v1
// `session/resume` cannot give: silently attaching without it would be reinterpreting the request.

import { type AcpClientOptionsV0, AcpClientV0 } from "./client.ts";
import {
	AcpClientV2,
	type AcpV2ClientOptionsV0,
	type AcpV2SessionOpenV0,
	AcpVersionNegotiationErrorV0,
} from "./client-v2.ts";

export type AcpNegotiatedV0 =
	| { readonly version: 2; readonly client: AcpClientV2; readonly fallback: null }
	| {
			readonly version: 1;
			readonly client: AcpClientV0;
			/** The v2 offer that was made and what the agent answered. */
			readonly fallback: { readonly offered: 2; readonly answered: 1 };
	  };

export interface AcpNegotiationOptionsV0 {
	readonly v2: AcpV2ClientOptionsV0;
	/** Present: an agent that answers 1 is attached with the v1 client. Absent: that answer is an error. */
	readonly fallbackToV1?: AcpClientOptionsV0;
}

export async function connectAcpNegotiatedV0(
	options: AcpNegotiationOptionsV0,
	open: AcpV2SessionOpenV0,
): Promise<AcpNegotiatedV0> {
	try {
		return { version: 2, client: await AcpClientV2.connect(options.v2, open), fallback: null };
	} catch (error) {
		if (
			!(error instanceof AcpVersionNegotiationErrorV0) ||
			error.kind !== "agent-answered-v1" ||
			options.fallbackToV1 === undefined
		)
			throw error;
		if (open.resume?.replay !== undefined)
			throw new TypeError(
				"the agent speaks ACP v1, which cannot replay history on resume; the request was not downgraded",
			);
		const client = await AcpClientV0.connect(options.fallbackToV1, {
			cwd: open.cwd,
			...(open.resume === undefined ? {} : { resume: { sessionId: open.resume.sessionId } }),
		});
		return { version: 1, client, fallback: { offered: 2, answered: 1 } };
	}
}
