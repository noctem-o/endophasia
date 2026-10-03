/**
 * Phase 12 — the OpenAI-compatible HTTP adapter (README "## Phase 12 — Operational substrate &
 * integration"): an `EndoModelProviderV0` implementation for any backend that speaks the
 * OpenAI `POST /chat/completions` wire format (including local servers such as Ollama or
 * llama.cpp server). The transport is injected by the host — this module never imports a
 * network stack and never opens a connection, so it runs wherever the host does and is
 * tested with an in-memory transport.
 *
 * Mapping: the neutral request becomes the OpenAI chat-completion body (undefined optional
 * parameters are omitted from the wire body, never sent as `null`); a 2xx body becomes the
 * recorded response or stream (the SSE deltas become the stream events, in order); a non-2xx
 * status becomes the recorded error with `code` the status string and `retryable` true for
 * 429 and 5xx; a transport failure becomes the recorded error with `code` "transport". A 2xx
 * body that is not a well-formed OpenAI completion is a broken transport contract — the
 * adapter throws TypeError rather than recording a fabricated outcome. Every returned record
 * exits through its protocol validator, and every outcome id is `endo.evidence.<label>.<sha256
 * of the request's canonical JSON>`: stable per call, and a retry (a new request id) mints a
 * new one.
 */

import type {
	EndoModelProviderV0,
	EndoProviderCompleteResultV0,
	EndoProviderStreamResultV0,
} from "../../models/provider/contract.ts";
import { isPlainJsonObjectV0 } from "../../protocol/primitives.ts";
import type {
	EndoProviderCapabilitiesV0,
	EndoProviderErrorV0,
	EndoProviderHealthStatusV0,
	EndoProviderHealthV0,
	EndoProviderRequestV0,
	EndoProviderResponseV0,
	EndoProviderStreamEventV0,
	EndoProviderStreamV0,
	EndoProviderUsageV0,
} from "../../protocol/provider.ts";
import {
	validateEndoProviderCapabilitiesV0,
	validateEndoProviderErrorV0,
	validateEndoProviderHealthV0,
	validateEndoProviderRequestV0,
	validateEndoProviderResponseV0,
	validateEndoProviderStreamV0,
} from "../../protocol/provider.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

/** One injected transport request: a method, a path, headers, and an optional body. */
export interface EndoOpenAiTransportRequestV0 {
	method: "GET" | "POST";
	path: string;
	headers: Record<string, string>;
	body?: string;
}

/** One injected transport outcome: the status and the full body. */
export interface EndoOpenAiTransportResultV0 {
	status: number;
	body: string;
}

/**
 * The injected transport. The adapter makes exactly one transport call per complete/stream/
 * health operation and reads the full body — for streaming, the SSE body arrives complete
 * and is parsed here.
 */
export interface EndoOpenAiTransportV0 {
	request(options: EndoOpenAiTransportRequestV0): Promise<EndoOpenAiTransportResultV0>;
}

/** The declared capability flags the host asserts for this provider. */
export interface EndoOpenAiDeclaredCapabilitiesV0 {
	streaming: boolean;
	tools: boolean;
	vision: boolean;
	maxContextTokens?: number;
}

/** The options the host passes to `createEndoOpenAiProviderV0`. */
export interface EndoOpenAiProviderOptionsV0 {
	/** The provider name, opaque — recorded as-is. */
	provider: string;
	/** The endpoint base, e.g. `https://api.openai.com/v1` (a trailing slash is stripped). */
	endpoint: string;
	/** The bearer credential; an empty string omits the Authorization header. */
	apiKey: string;
	/** The declared capabilities, recorded as-is by `capabilities()`. */
	capabilities: EndoOpenAiDeclaredCapabilitiesV0;
	/** The injected transport. */
	transport: EndoOpenAiTransportV0;
}

const OPENAI_OPTION_KEYS_V0 = new Set(["provider", "endpoint", "apiKey", "capabilities", "transport"]);
const OPENAI_ERROR_MESSAGE_LIMIT_V0 = 4096;

/** The wire error for a transport-level failure: code "transport", retryable. */
function transportErrorV0(request: EndoProviderRequestV0, error: unknown): EndoProviderErrorV0 {
	const message = (error instanceof Error ? error.message : String(error)) || "transport failure";
	const record: EndoProviderErrorV0 = {
		schemaVersion: "endo.provider-error.v0",
		id: outcomeIdV0("provider-error", request),
		requestId: request.id,
		code: "transport",
		message: truncateV0(message),
		retryable: true,
	};
	return validatedErrorV0(record);
}

/** The wire error for a non-2xx status: code the status string, retryable for 429 and 5xx. */
function httpErrorV0(request: EndoProviderRequestV0, result: EndoOpenAiTransportResultV0): EndoProviderErrorV0 {
	const record: EndoProviderErrorV0 = {
		schemaVersion: "endo.provider-error.v0",
		id: outcomeIdV0("provider-error", request),
		requestId: request.id,
		code: String(result.status),
		message: truncateV0(bodyMessageV0(result.body, result.status)),
		retryable: result.status === 429 || result.status >= 500,
	};
	return validatedErrorV0(record);
}

/** The outcome id: `endo.evidence.<label>.<sha256 of the request's canonical JSON>`. */
function outcomeIdV0(label: string, request: EndoProviderRequestV0): string {
	return `endo.evidence.${label}.${sha256HexV0(canonicalEndoJsonV0(request))}`;
}

function truncateV0(message: string): string {
	return message.length > OPENAI_ERROR_MESSAGE_LIMIT_V0 ? message.slice(0, OPENAI_ERROR_MESSAGE_LIMIT_V0) : message;
}

function validatedErrorV0(record: EndoProviderErrorV0): EndoProviderErrorV0 {
	const validated = validateEndoProviderErrorV0(record);
	if (validated === null) throw new TypeError("the recorded provider error failed validation");
	return validated;
}

/** The provider's own error message from an error body (the OpenAI `error.message` envelope, or a
 * top-level `message`), or the status line when the body carries neither. */
function bodyMessageV0(body: string, status: number): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			const envelope = record.error;
			if (typeof envelope === "object" && envelope !== null) {
				const nested = (envelope as Record<string, unknown>).message;
				if (typeof nested === "string" && nested.length >= 1) return nested;
			}
			const message = record.message;
			if (typeof message === "string" && message.length >= 1) return message;
		}
	} catch {
		// The body is not JSON: fall through to the status line.
	}
	return `HTTP ${status}`;
}

/** Parse a 2xx wire body as JSON, or throw TypeError: a non-JSON 2xx body is a broken contract. */
function parseWireJsonV0(body: string, label: string): unknown {
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new TypeError(`the ${label} body is not valid JSON`);
	}
}

/** The chat-completion body: the neutral request mapped to the OpenAI wire shape. */
function chatBodyV0(request: EndoProviderRequestV0): string {
	return JSON.stringify({
		model: request.modelId,
		messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
		stream: request.stream,
		max_tokens: request.maxTokens,
		temperature: request.temperature,
	});
}

/** The request headers: content-type always, Authorization only when a key is set. */
function requestHeadersV0(apiKey: string): Record<string, string> {
	return {
		"content-type": "application/json",
		...(apiKey !== "" && { authorization: `Bearer ${apiKey}` }),
	};
}

/** The completion choice: the first choice of a well-formed completion body, or TypeError. */
function completionChoiceV0(parsed: unknown, label: string): Record<string, unknown> {
	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>).choices)) {
		throw new TypeError(`the ${label} body has no choices`);
	}
	const choices = (parsed as Record<string, unknown>).choices as unknown[];
	if (choices.length === 0) throw new TypeError(`the ${label} body has an empty choices list`);
	if (typeof choices[0] !== "object" || choices[0] === null)
		throw new TypeError(`the first choice of the ${label} body is not an object`);
	return choices[0] as Record<string, unknown>;
}

/** The completion message content: a string, or the empty string when the provider recorded none. */
function completionContentV0(choice: Record<string, unknown>, label: string): string {
	const message = choice.message;
	if (typeof message !== "object" || message === null)
		throw new TypeError(`the first choice of the ${label} body has no message`);
	const content = (message as Record<string, unknown>).content;
	return typeof content === "string" ? content : "";
}

/** The finish reason the provider gave, when it gave a non-empty string one. */
function completionFinishReasonV0(choice: Record<string, unknown>): string | undefined {
	const finishReason = choice.finish_reason;
	return typeof finishReason === "string" && finishReason.length >= 1 ? finishReason : undefined;
}

/** The usage the provider reported, when it reported a well-formed one. */
function completionUsageV0(parsed: unknown): EndoProviderUsageV0 | undefined {
	const usage = (parsed as Record<string, unknown>).usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const v = usage as Record<string, unknown>;
	if (typeof v.prompt_tokens !== "number" || !Number.isFinite(v.prompt_tokens) || v.prompt_tokens < 0)
		return undefined;
	if (typeof v.completion_tokens !== "number" || !Number.isFinite(v.completion_tokens) || v.completion_tokens < 0)
		return undefined;
	return {
		schemaVersion: "endo.provider-usage.v0",
		inputTokens: v.prompt_tokens,
		outputTokens: v.completion_tokens,
		...(typeof v.total_tokens === "number" &&
			Number.isFinite(v.total_tokens) &&
			v.total_tokens >= 0 && { totalTokens: v.total_tokens }),
	};
}

/** The SSE content deltas of a streaming body, in order. */
function streamEventsV0(body: string): EndoProviderStreamEventV0[] {
	const events: EndoProviderStreamEventV0[] = [];
	let sawDataLine = false;
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith("data:")) continue;
		sawDataLine = true;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]") break;
		const chunk: unknown = parseWireJsonV0(payload, "stream chunk");
		if (typeof chunk !== "object" || chunk === null) throw new TypeError("a stream chunk is not a JSON object");
		const choices = (chunk as Record<string, unknown>).choices;
		if (!Array.isArray(choices)) continue;
		for (const choice of choices) {
			if (typeof choice !== "object" || choice === null) throw new TypeError("a stream choice is not a JSON object");
			const delta = (choice as Record<string, unknown>).delta;
			if (typeof delta !== "object" || delta === null) continue;
			const content = (delta as Record<string, unknown>).content;
			if (typeof content === "string") events.push({ sequence: events.length, delta: content });
		}
	}
	if (!sawDataLine) throw new TypeError("the stream body carries no data lines");
	return events;
}

/** The usage a streaming body reported at its end, when it reported one. */
function streamUsageV0(body: string): EndoProviderUsageV0 | undefined {
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]") break;
		const chunk: unknown = parseWireJsonV0(payload, "stream chunk");
		if (typeof chunk !== "object" || chunk === null) continue;
		const usage = completionUsageV0(chunk);
		if (usage !== undefined) return usage;
	}
	return undefined;
}

function isValidatedRequestV0(value: unknown): EndoProviderRequestV0 {
	const validated = validateEndoProviderRequestV0(value);
	if (validated === null) throw new TypeError("the provider request failed validation");
	return validated;
}

/**
 * Build the OpenAI-compatible provider. The options take `unknown` at the door (the house
 * boundary pattern) and throw TypeError on anything malformed; `capabilities()` returns the
 * host's declaration with a stable id, and `health()` probes `GET <endpoint>/models`.
 */
export function createEndoOpenAiProviderV0(value: unknown): EndoModelProviderV0 {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) {
		throw new TypeError("provider options must be a plain object");
	}
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v))
		if (!OPENAI_OPTION_KEYS_V0.has(key)) throw new TypeError(`unknown provider option ${key}`);
	if (typeof v.provider !== "string" || v.provider.length < 1 || v.provider.length > 256) {
		throw new TypeError("provider must be a non-empty name of at most 256 characters");
	}
	if (typeof v.endpoint !== "string" || v.endpoint.length < 1)
		throw new TypeError("endpoint must be a non-empty string");
	if (typeof v.apiKey !== "string") throw new TypeError("apiKey must be a string");
	if (
		typeof v.transport !== "object" ||
		v.transport === null ||
		typeof (v.transport as Record<string, unknown>).request !== "function"
	) {
		throw new TypeError("transport must be an object with a request function");
	}
	const caps: unknown = v.capabilities;
	if (typeof caps !== "object" || caps === null || !isPlainJsonObjectV0(caps)) {
		throw new TypeError("capabilities must be a plain object");
	}
	const capsV = caps as Record<string, unknown>;
	for (const key of Object.keys(capsV)) {
		if (!new Set(["streaming", "tools", "vision", "maxContextTokens"]).has(key))
			throw new TypeError(`unknown capability option ${key}`);
	}
	const streaming = capsV.streaming;
	const tools = capsV.tools;
	const vision = capsV.vision;
	const maxContextTokens = capsV.maxContextTokens;
	if (typeof streaming !== "boolean" || typeof tools !== "boolean" || typeof vision !== "boolean") {
		throw new TypeError("capabilities.streaming, capabilities.tools, and capabilities.vision must be booleans");
	}
	if (maxContextTokens !== undefined && (typeof maxContextTokens !== "number" || !Number.isFinite(maxContextTokens))) {
		throw new TypeError("capabilities.maxContextTokens must be a finite number when set");
	}

	const provider: string = v.provider;
	const endpoint: string = v.endpoint.replace(/\/+$/, "");
	const apiKey: string = v.apiKey;
	const transport: EndoOpenAiTransportV0 = v.transport as EndoOpenAiTransportV0;
	const chatPath = `${endpoint}/chat/completions`;
	const modelsPath = `${endpoint}/models`;

	const providerV0: EndoModelProviderV0 = {
		provider,
		async complete(request: EndoProviderRequestV0): Promise<EndoProviderCompleteResultV0> {
			const validatedRequest = isValidatedRequestV0(request);
			const startedAt = Date.now();
			let result: EndoOpenAiTransportResultV0;
			try {
				result = await transport.request({
					method: "POST",
					path: chatPath,
					headers: requestHeadersV0(apiKey),
					body: chatBodyV0(validatedRequest),
				});
			} catch (error) {
				return { ok: false, error: transportErrorV0(validatedRequest, error) };
			}
			if (result.status < 200 || result.status >= 300)
				return { ok: false, error: httpErrorV0(validatedRequest, result) };
			const parsed: unknown = parseWireJsonV0(result.body, "completion");
			const choice = completionChoiceV0(parsed, "completion");
			const finishReason = completionFinishReasonV0(choice);
			const usage = completionUsageV0(parsed);
			const record: EndoProviderResponseV0 = {
				schemaVersion: "endo.provider-response.v0",
				id: outcomeIdV0("provider-response", validatedRequest),
				requestId: validatedRequest.id,
				content: completionContentV0(choice, "completion"),
				...(finishReason !== undefined && { finishReason }),
				...(usage !== undefined && { usage }),
				durationMs: Date.now() - startedAt,
			};
			const validated = validateEndoProviderResponseV0(record);
			if (validated === null) throw new TypeError("the recorded provider response failed validation");
			return { ok: true, response: validated };
		},
		async stream(request: EndoProviderRequestV0): Promise<EndoProviderStreamResultV0> {
			const validatedRequest = isValidatedRequestV0(request);
			const startedAt = Date.now();
			let result: EndoOpenAiTransportResultV0;
			try {
				result = await transport.request({
					method: "POST",
					path: chatPath,
					headers: requestHeadersV0(apiKey),
					body: chatBodyV0(validatedRequest),
				});
			} catch (error) {
				return { ok: false, error: transportErrorV0(validatedRequest, error) };
			}
			if (result.status < 200 || result.status >= 300)
				return { ok: false, error: httpErrorV0(validatedRequest, result) };
			const events = streamEventsV0(result.body);
			const usage = streamUsageV0(result.body);
			const record: EndoProviderStreamV0 = {
				schemaVersion: "endo.provider-stream.v0",
				id: outcomeIdV0("provider-stream", validatedRequest),
				requestId: validatedRequest.id,
				events,
				...(usage !== undefined && { usage }),
				durationMs: Date.now() - startedAt,
			};
			const validated = validateEndoProviderStreamV0(record);
			if (validated === null) throw new TypeError("the recorded provider stream failed validation");
			return { ok: true, stream: validated };
		},
		capabilities(): EndoProviderCapabilitiesV0 {
			const declaration: Record<string, unknown> = {
				provider,
				streaming,
				tools,
				vision,
			};
			if (maxContextTokens !== undefined) declaration.maxContextTokens = maxContextTokens;
			const record: EndoProviderCapabilitiesV0 = {
				schemaVersion: "endo.provider-capabilities.v0",
				id: `endo.evidence.provider-capabilities.${sha256HexV0(canonicalEndoJsonV0(declaration))}`,
				provider,
				streaming,
				tools,
				vision,
				...(maxContextTokens !== undefined && { maxContextTokens }),
			};
			const validated = validateEndoProviderCapabilitiesV0(record);
			if (validated === null) throw new TypeError("the declared provider capabilities failed validation");
			return validated;
		},
		async health(): Promise<EndoProviderHealthV0> {
			const startedAt = Date.now();
			let status: number | null = null;
			try {
				const result = await transport.request({
					method: "GET",
					path: modelsPath,
					headers: requestHeadersV0(apiKey),
				});
				status = result.status;
			} catch {
				status = null;
			}
			const healthStatus: EndoProviderHealthStatusV0 =
				status === null ? "down" : status < 400 ? "up" : status < 500 ? "degraded" : "down";
			const record: EndoProviderHealthV0 = {
				schemaVersion: "endo.provider-health.v0",
				id: `endo.evidence.provider-health.${sha256HexV0(canonicalEndoJsonV0({ provider, status: healthStatus, ...(status !== null && { latencyMs: Date.now() - startedAt }) }))}`,
				provider,
				status: healthStatus,
				...(status !== null && { latencyMs: Date.now() - startedAt }),
			};
			const validated = validateEndoProviderHealthV0(record);
			if (validated === null) throw new TypeError("the recorded provider health failed validation");
			return validated;
		},
	};
	return providerV0;
}
