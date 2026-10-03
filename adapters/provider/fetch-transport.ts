/**
 * A host transport for the OpenAI-compatible adapter (openai.ts) over the platform `fetch`. The adapter stays
 * transport-free; a host that wants real HTTP composes it with this. It reads the whole body before returning, which
 * is the adapter's contract: the adapter parses a streaming (SSE) body only after it has arrived complete, so
 * `stream()` delivers its events at once at the end, not incrementally. A request that does not finish within
 * `timeoutMs` rejects, which the adapter records as a retryable `transport` error.
 */
import type { EndoOpenAiTransportV0 } from "./openai.ts";

export function createEndoFetchTransportV0(options: { timeoutMs?: number } = {}): EndoOpenAiTransportV0 {
	const timeoutMs = options.timeoutMs ?? 120_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
	return {
		async request({ method, path, headers, body }) {
			const response = await fetch(path, {
				method,
				headers,
				...(body === undefined ? {} : { body }),
				signal: AbortSignal.timeout(timeoutMs),
			});
			return { status: response.status, body: await response.text() };
		},
	};
}
