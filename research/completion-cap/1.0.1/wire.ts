// Reads one recorded response (the proxy's wire bytes: an HTTP status line, headers and a chunked server-sent-event
// body from llama.cpp) into the few numbers this study needs. Pure: tested on synthetic wire text.

export interface WireSummaryV0 {
	httpStatus: number | null;
	/** The last non-null `finish_reason` ("stop", "tool_calls", "length"), or null if none was streamed. */
	finishReason: string | null;
	promptTokens: number | null;
	completionTokens: number | null;
	/** llama.cpp's own timings, when present: tokens generated and milliseconds spent generating and on the prompt. */
	predictedTokens: number | null;
	predictedMs: number | null;
	promptMs: number | null;
	/** Characters streamed as `reasoning_content` and as `content`. */
	reasoningChars: number;
	contentChars: number;
}

function dechunk(body: string): string {
	let out = "";
	let at = 0;
	for (;;) {
		const eol = body.indexOf("\r\n", at);
		if (eol === -1) break;
		const size = Number.parseInt(body.slice(at, eol), 16);
		if (!Number.isFinite(size) || size === 0) break;
		out += body.slice(eol + 2, eol + 2 + size);
		at = eol + 2 + size + 2;
	}
	return out;
}

export function parseWireV0(wire: string): WireSummaryV0 {
	const split = wire.indexOf("\r\n\r\n");
	const head = split === -1 ? wire : wire.slice(0, split);
	const raw = split === -1 ? "" : wire.slice(split + 4);
	const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
	const body = /transfer-encoding:\s*chunked/i.test(head) ? dechunk(raw) : raw;
	const summary: WireSummaryV0 = {
		httpStatus: status ? Number(status[1]) : null,
		finishReason: null,
		promptTokens: null,
		completionTokens: null,
		predictedTokens: null,
		predictedMs: null,
		promptMs: null,
		reasoningChars: 0,
		contentChars: 0,
	};
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ") || line.startsWith("data: [DONE]")) continue;
		let event: {
			choices?: {
				finish_reason?: string | null;
				delta?: { reasoning_content?: string | null; content?: string | null };
			}[];
			usage?: { prompt_tokens?: number; completion_tokens?: number };
			timings?: { predicted_n?: number; predicted_ms?: number; prompt_ms?: number };
		};
		try {
			event = JSON.parse(line.slice(6));
		} catch {
			continue;
		}
		for (const choice of event.choices ?? []) {
			if (typeof choice.finish_reason === "string") summary.finishReason = choice.finish_reason;
			summary.reasoningChars += choice.delta?.reasoning_content?.length ?? 0;
			summary.contentChars += choice.delta?.content?.length ?? 0;
		}
		if (event.usage) {
			summary.promptTokens = event.usage.prompt_tokens ?? summary.promptTokens;
			summary.completionTokens = event.usage.completion_tokens ?? summary.completionTokens;
		}
		if (event.timings) {
			summary.predictedTokens = event.timings.predicted_n ?? summary.predictedTokens;
			summary.predictedMs = event.timings.predicted_ms ?? summary.predictedMs;
			summary.promptMs = event.timings.prompt_ms ?? summary.promptMs;
		}
	}
	return summary;
}
