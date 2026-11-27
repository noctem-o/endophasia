import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	coordinatorToolRefusalV0,
	ENDO_COORDINATOR_TOOL_DEFINITION_V0,
	ENDO_COORDINATOR_TOOL_V0,
	type EndoCoordinatorBriefRefusalV0,
} from "../../runtime/contracts/coordinator-brief.ts";
import { Http1ParserV0, http1HeaderValuesV0 } from "../openai-proxy/http1.ts";

export const COORDINATOR_INFERENCE_V0 = Object.freeze({
	temperature: 0,
	top_k: 1,
	top_p: 1,
	min_p: 0,
	seed: 101,
	max_tokens: 2048,
});

export type EndoCoordinatorWireInferenceV0 = Readonly<
	Record<keyof typeof COORDINATOR_INFERENCE_V0, number> & {
		readonly reasoning_effort?: string;
		readonly reasoning_budget_tokens?: number;
	}
>;

/**
 * Closed top-level request fields allowed on `/v1/chat/completions` beyond the exact keys in `inference` (F3).
 * Any undeclared key (such as `reasoning_format`, `reasoning`, `thinking`, `chat_template_kwargs`, `enable_thinking`,
 * `ignore_eos`, `min_tokens`, `samplers`, `mirostat`, `logit_bias`, `grammar`, `response_format`, `stop`, `logprobs`,
 * `n_predict`, `max_completion_tokens`, etc.) is refused fail-closed.
 */
const ALLOWED_WIRE_REQUEST_KEYS_V1 = new Set([
	"model",
	"messages",
	"tools",
	"stream",
	"stream_options",
	"store",
	"tool_choice",
]);

const SAFE_FINISH_REASON_V1 = /^[a-zA-Z0-9_-]{1,32}$/;

function sanitizeFinishReasonV1(raw: string): string {
	return SAFE_FINISH_REASON_V1.test(raw) ? raw : "other";
}

function validStreamOptionsV1(value: unknown): boolean {
	if (value === undefined) return true;
	const obj = record(value);
	if (obj === null) return false;
	for (const key of Object.keys(obj)) {
		if (key !== "include_usage") return false;
	}
	return obj.include_usage === undefined || typeof obj.include_usage === "boolean";
}

const TOOL_SET_V0 = canonicalEndoJsonV0([{ type: "function", function: ENDO_COORDINATOR_TOOL_DEFINITION_V0 }]);

const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function coordinatorWireV0(
	projectId: string,
	toolText: string,
	bearer: string,
	onRefused?: () => void,
	options: {
		/** The exact inference parameters admitted; M0's by default. */
		readonly inference?: EndoCoordinatorWireInferenceV0;
		/** When set, every response chunk must name exactly this model, else `model-identity-mismatch`. */
		readonly model?: string;
	} = {},
) {
	const inference = options.inference ?? COORDINATOR_INFERENCE_V0;
	const trace = {
		toolDefinitions: [] as JsonValueV0[],
		statusDelivered: false,
		statusMessage: null as JsonValueV0,
		inference: [] as Record<string, JsonValueV0>[],
		responses: [] as {
			finish: string | null;
			usage: JsonValueV0;
			text: string;
			toolCalled: boolean;
			sawReasoning?: boolean;
			reasoningChars?: number;
			sawVisibleContent?: boolean;
			visibleChars?: number;
			reasoningTokens?: number | null;
		}[],
		refusal: null as EndoCoordinatorBriefRefusalV0 | null,
	};
	let id: string | null = null;
	let requests = 0;
	const refuse = (reason: EndoCoordinatorBriefRefusalV0) => {
		if (trace.refusal === null) {
			trace.refusal = reason;
			onRefused?.();
		}
		return false;
	};

	return {
		trace,
		request({ body, headers }: { body: Uint8Array; headers: readonly [string, string][] }) {
			const auth = headers.filter(([name]) => name.toLowerCase() === "authorization");
			if (auth.length !== 1 || auth[0]?.[1] !== `Bearer ${bearer}`) return false;
			if (trace.refusal !== null) return false;
			const sent = record(JSON.parse(Buffer.from(body).toString("utf8")));
			if (sent === null) return refuse("model-unavailable");
			const tools = Array.isArray(sent.tools) ? (sent.tools as JsonValueV0[]) : [];
			trace.toolDefinitions.push(tools);
			trace.inference.push(
				Object.fromEntries(Object.keys(inference).map((field) => [field, (sent[field] ?? null) as JsonValueV0])),
			);
			if (canonicalEndoJsonV0(tools) !== TOOL_SET_V0 || "functions" in sent || "function_call" in sent)
				return refuse("tool-surface-mismatch");
			const unknownKey = Object.keys(sent).find(
				(key) => !ALLOWED_WIRE_REQUEST_KEYS_V1.has(key) && !Object.hasOwn(inference, key),
			);
			if (
				unknownKey !== undefined ||
				Object.entries(inference).some(([key, expected]) => sent[key] !== expected) ||
				sent.stream !== true ||
				!validStreamOptionsV1(sent.stream_options) ||
				("store" in sent && sent.store !== false) ||
				("tool_choice" in sent && sent.tool_choice !== "auto")
			)
				return refuse("model-unavailable");
			if (!Array.isArray(sent.messages)) return refuse("model-unavailable");
			const toolMessages = sent.messages.map(record).filter((m) => m?.role === "tool");
			if (requests === 0) {
				if (toolMessages.length !== 0) return refuse("ungrounded");
			} else {
				const message = toolMessages[0];
				trace.statusMessage = (message ?? null) as JsonValueV0;
				if (
					requests !== 1 ||
					id === null ||
					toolMessages.length !== 1 ||
					(message?.tool_call_id !== id &&
						message?.tool_call_id !== id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40)) ||
					message.content !== toolText
				)
					return refuse("ungrounded");
				trace.statusDelivered = true;
			}
			requests += 1;
			return true;
		},
		response({ status, wire }: { status: number; wire: Uint8Array }) {
			if (trace.refusal !== null) return false;
			if (status !== 200) {
				const sentReasoningControl =
					Object.hasOwn(inference, "reasoning_effort") || Object.hasOwn(inference, "reasoning_budget_tokens");
				if (sentReasoningControl && (status === 400 || status === 422)) {
					const rawText = Buffer.from(wire).toString("utf8", 0, Math.min(wire.length, 8192));
					const bodySep = rawText.indexOf("\r\n\r\n");
					const bodyText = (bodySep >= 0 ? rawText.slice(bodySep + 4) : rawText).slice(0, 4096).toLowerCase();
					const namesControl =
						bodyText.includes("reasoning_effort") || bodyText.includes("reasoning_budget_tokens");
					const mentionsReasoningRejection =
						(bodyText.includes("reasoning") || bodyText.includes("thinking")) &&
						(bodyText.includes("unsupported") ||
							bodyText.includes("unknown") ||
							bodyText.includes("invalid") ||
							bodyText.includes("unrecognized"));
					if (namesControl || mentionsReasoningRejection) {
						return refuse("unsupported-reasoning-control");
					}
				}
				return refuse("model-unavailable");
			}
			try {
				const parts: Buffer[] = [];
				let sse = false;
				const parser = new Http1ParserV0(
					"response",
					{
						head: (head) => {
							const types = http1HeaderValuesV0(head.headers, "content-type");
							sse = types.length === 1 && /^text\/event-stream(?:;|$)/i.test(types[0]!);
						},
						body: (bytes) => parts.push(bytes),
						end: () => {},
					},
					{ strictChunks: true },
				);
				parser.push(Buffer.from(wire));
				if (!parser.close() || !sse) return refuse("model-unavailable");
				let done = false;
				let responseId = "";
				let name = "";
				let args = "";
				let finish: string | null = null;
				let text = "";
				let usage: JsonValueV0 = null;
				let toolCalled = false;
				let reasoningChars = 0;
				let reasoningTokens: number | null = null;
				for (const line of Buffer.concat(parts).toString("utf8").split(/\r?\n/)) {
					if (line === "" || line.startsWith(":")) continue;
					if (!line.startsWith("data:") || done) return refuse("model-unavailable");
					const data = line.slice(5).trim();
					if (data === "[DONE]") {
						done = true;
						continue;
					}
					const item = record(JSON.parse(data));
					if (item === null || !Array.isArray(item.choices) || item.choices.length > 1)
						return refuse("model-unavailable");
					if (options.model !== undefined && item.model !== options.model)
						return refuse("model-identity-mismatch");
					const usageRecord = record(item.usage);
					if (usageRecord !== null) {
						usage = item.usage as JsonValueV0;
						const details = record(usageRecord.completion_tokens_details);
						const reportedReasoning = details?.reasoning_tokens;
						if (
							typeof reportedReasoning === "number" &&
							Number.isSafeInteger(reportedReasoning) &&
							reportedReasoning >= 0
						) {
							reasoningTokens = reportedReasoning;
						}
					}
					for (const choice of item.choices) {
						const c = record(choice);
						const d = record(c?.delta);
						if (c?.index !== 0 || d === null) return refuse("model-unavailable");
						if (typeof c.finish_reason === "string") finish = sanitizeFinishReasonV1(c.finish_reason);
						if (typeof d.content === "string") text += d.content;
						// Count reasoning characters without ever storing raw reasoning content.
						if (typeof d.reasoning_content === "string") reasoningChars += d.reasoning_content.length;
						else if (typeof d.reasoning === "string") reasoningChars += d.reasoning.length;
						if (d.function_call !== undefined && d.function_call !== null) return refuse("tool-not-permitted");
						if (d.tool_calls === undefined || d.tool_calls === null) continue;
						if (!Array.isArray(d.tool_calls)) return refuse("tool-not-permitted");
						for (const entry of d.tool_calls) {
							toolCalled = true;
							const call = record(entry);
							const f = record(call?.function);
							if (call?.index !== 0 || (call.type !== undefined && call.type !== "function") || f === null)
								return refuse("tool-not-permitted");
							if (typeof call.id === "string") responseId += call.id;
							if (typeof f.name === "string") name += f.name;
							if (typeof f.arguments === "string") args += f.arguments;
						}
					}
				}
				trace.responses.push({
					finish,
					usage,
					text,
					toolCalled,
					sawReasoning: reasoningChars > 0 || (reasoningTokens !== null && reasoningTokens > 0),
					reasoningChars,
					sawVisibleContent: text.trim().length > 0,
					visibleChars: text.length,
					reasoningTokens,
				});
				if (!done || finish === null) return refuse("model-unavailable");
				if (toolCalled) {
					if (
						requests === 1 &&
						id === null &&
						finish === "length" &&
						(name === "" || ENDO_COORDINATOR_TOOL_V0.startsWith(name))
					)
						return refuse("generation-limit");
					if (
						requests !== 1 ||
						id !== null ||
						!/^(?=.*[a-zA-Z0-9])[a-zA-Z0-9_-]{1,80}$/.test(responseId) ||
						finish !== "tool_calls" ||
						name !== ENDO_COORDINATOR_TOOL_V0
					)
						return refuse("tool-not-permitted");
					let params: unknown;
					try {
						params = JSON.parse(args);
					} catch {
						return refuse("malformed-selector");
					}
					const failure = coordinatorToolRefusalV0(projectId, name, params);
					if (failure !== null) return refuse(failure);
					id = responseId;
				} else if (finish === "tool_calls") return refuse("tool-not-permitted");
				return true;
			} catch {
				return refuse("model-unavailable");
			}
		},
	};
}
