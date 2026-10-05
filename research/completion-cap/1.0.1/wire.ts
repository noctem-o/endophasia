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

/** Chunk sizes count bytes, not characters, so the body is decoded after the chunks are cut out of the bytes. */
function dechunk(body: Buffer): string {
	const parts: Buffer[] = [];
	let at = 0;
	for (;;) {
		const eol = body.indexOf("\r\n", at);
		if (eol === -1) break;
		const size = Number.parseInt(body.subarray(at, eol).toString("latin1"), 16);
		if (!Number.isFinite(size) || size === 0) break;
		parts.push(body.subarray(eol + 2, eol + 2 + size));
		at = eol + 2 + size + 2;
	}
	return Buffer.concat(parts).toString("utf8");
}

export function parseWireV0(input: string | Uint8Array): WireSummaryV0 {
	const wire = Buffer.from(typeof input === "string" ? Buffer.from(input, "utf8") : input);
	const split = wire.indexOf("\r\n\r\n");
	const head = (split === -1 ? wire : wire.subarray(0, split)).toString("utf8");
	const raw = split === -1 ? Buffer.alloc(0) : wire.subarray(split + 4);
	const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
	const body = /transfer-encoding:\s*chunked/i.test(head) ? dechunk(raw) : raw.toString("utf8");
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
