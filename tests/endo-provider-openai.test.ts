/**
 * Phase 12 — the OpenAI-compatible adapter against an in-memory transport: the wire mapping
 * (request body, headers, SSE parsing), the outcome records (response, stream, error) and
 * their stable ids, the recorded errors for non-2xx statuses and transport failures, the
 * capabilities declaration, and the health probe. No network is touched: the transport is
 * a fake that records its calls and returns scripted bodies.
 */

import { describe, expect, it } from "vitest";
import type { EndoOpenAiTransportRequestV0, EndoOpenAiTransportV0 } from "../adapters/provider/openai.ts";
import { createEndoOpenAiProviderV0 } from "../adapters/provider/openai.ts";
import { isEndoIdentifierV0 } from "../protocol/identity.ts";
import type { EndoProviderRequestV0 } from "../protocol/provider.ts";
import {
	validateEndoProviderCapabilitiesV0,
	validateEndoProviderErrorV0,
	validateEndoProviderHealthV0,
	validateEndoProviderResponseV0,
	validateEndoProviderStreamV0,
} from "../protocol/provider.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";

const ENDPOINT = "https://api.example.com/v1";

const REQUEST: EndoProviderRequestV0 = {
	schemaVersion: "endo.provider-request.v0",
	id: "endo.evidence.call-1",
	provider: "openai",
	modelId: "gpt-4o-mini",
	messages: [
		{ role: "system", content: "You are terse." },
		{ role: "user", content: "Hello" },
	],
	maxTokens: 64,
	temperature: 0.2,
};

interface FakeTransport {
	calls: EndoOpenAiTransportRequestV0[];
	transport: EndoOpenAiTransportV0;
}

/** A scripted in-memory transport that records every call it receives. */
function createFakeTransportV0(
	respond: (
		call: EndoOpenAiTransportRequestV0,
	) => { status: number; body: string } | Promise<{ status: number; body: string }>,
): FakeTransport {
	const calls: EndoOpenAiTransportRequestV0[] = [];
	const transport: EndoOpenAiTransportV0 = {
		async request(call) {
			calls.push(call);
			return respond(call);
		},
	};
	return { calls, transport };
}

function optionsV0(overrides: Record<string, unknown> = {}) {
	return {
		provider: "openai",
		endpoint: ENDPOINT,
		apiKey: "sk-test",
		capabilities: { streaming: true, tools: true, vision: false },
		transport: {
			async request() {
				return { status: 200, body: "{}" };
			},
		},
		...overrides,
	};
}

const COMPLETION_BODY = JSON.stringify({
	id: "chatcmpl-1",
	choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
	usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
});

describe("createEndoOpenAiProviderV0 door", () => {
	it("rejects options with unknown keys, missing capabilities, and a transport without request", () => {
		expect(() => createEndoOpenAiProviderV0({ ...optionsV0(), extra: 1 })).toThrow(TypeError);
		expect(() => createEndoOpenAiProviderV0({ ...optionsV0(), extra: 1 })).toThrow(/unknown provider option extra/);
		expect(() => createEndoOpenAiProviderV0(optionsV0({ capabilities: undefined }))).toThrow(
			/capabilities must be a plain object/,
		);
		expect(() =>
			createEndoOpenAiProviderV0(optionsV0({ capabilities: { streaming: "yes", tools: true, vision: false } })),
		).toThrow(/must be booleans/);
		expect(() => createEndoOpenAiProviderV0(optionsV0({ transport: {} }))).toThrow(/request function/);
		expect(() => createEndoOpenAiProviderV0(optionsV0({ provider: "" }))).toThrow(/non-empty name/);
		expect(() => createEndoOpenAiProviderV0(optionsV0({ endpoint: "" }))).toThrow(/non-empty string/);
	});
});

describe("complete", () => {
	it("maps a 2xx completion to the recorded response with a stable id", async () => {
		const fake = createFakeTransportV0(() => ({ status: 200, body: COMPLETION_BODY }));
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		const result = await provider.complete(REQUEST);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.response.requestId).toBe(REQUEST.id);
		expect(result.response.content).toBe("Hi there");
		expect(result.response.finishReason).toBe("stop");
		expect(result.response.usage).toEqual({
			schemaVersion: "endo.provider-usage.v0",
			inputTokens: 12,
			outputTokens: 5,
			totalTokens: 17,
		});
		expect(Number.isInteger(result.response.durationMs)).toBe(true);
		expect(result.response.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.response.id).toBe(`endo.evidence.provider-response.${sha256HexV0(canonicalEndoJsonV0(REQUEST))}`);
		expect(validateEndoProviderResponseV0(result.response)).not.toBeNull();
		expect(JSON.parse(canonicalEndoJsonV0(result.response))).toEqual(result.response);
	});

	it("sends the neutral request as the OpenAI wire body with the bearer credential", async () => {
		const fake = createFakeTransportV0(() => ({ status: 200, body: COMPLETION_BODY }));
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		await provider.complete(REQUEST);
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.method).toBe("POST");
		expect(call.path).toBe(`${ENDPOINT}/chat/completions`);
		expect(call.headers).toEqual({ "content-type": "application/json", authorization: "Bearer sk-test" });
		expect(JSON.parse(call.body ?? "")).toEqual({
			model: "gpt-4o-mini",
			messages: [
				{ role: "system", content: "You are terse." },
				{ role: "user", content: "Hello" },
			],
			max_tokens: 64,
			temperature: 0.2,
		});
	});

	it("omits unset request parameters and absent provider reports on the wire and in the record", async () => {
		const request: EndoProviderRequestV0 = {
			schemaVersion: "endo.provider-request.v0",
			id: "endo.evidence.call-2",
			provider: "openai",
			modelId: "gpt-4o-mini",
			messages: [{ role: "user", content: "Hello" }],
		};
		const fake = createFakeTransportV0(() => ({
			status: 200,
			body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: null }] }),
		}));
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		const result = await provider.complete(request);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(JSON.parse(fake.calls[0].body ?? "")).toEqual({
			model: "gpt-4o-mini",
			messages: [{ role: "user", content: "Hello" }],
		});
		expect("usage" in result.response).toBe(false);
		expect("finishReason" in result.response).toBe(false);
	});

	it("omits the Authorization header when the key is empty", async () => {
		const fake = createFakeTransportV0(() => ({ status: 200, body: COMPLETION_BODY }));
		const provider = createEndoOpenAiProviderV0(optionsV0({ apiKey: "", transport: fake.transport }));
		await provider.complete(REQUEST);
		expect("authorization" in fake.calls[0].headers).toBe(false);
	});

	it("records a non-2xx status as the error with the status code and retryable flag", async () => {
		const body = JSON.stringify({ error: { message: "Invalid API key" } });
		for (const [status, retryable] of [
			[401, false],
			[404, false],
			[429, true],
			[500, true],
		] as const) {
			const fake = createFakeTransportV0(() => ({ status, body }));
			const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
			const result = await provider.complete(REQUEST);
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.error.code).toBe(String(status));
			expect(result.error.retryable).toBe(retryable);
			expect(result.error.message).toBe("Invalid API key");
			expect(result.error.requestId).toBe(REQUEST.id);
			expect(result.error.id).toBe(`endo.evidence.provider-error.${sha256HexV0(canonicalEndoJsonV0(REQUEST))}`);
			expect(validateEndoProviderErrorV0(result.error)).not.toBeNull();
		}
	});

	it("falls back to the status line when the error body carries no message", async () => {
		const fake = createFakeTransportV0(() => ({ status: 503, body: "nope" }));
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		const result = await provider.complete(REQUEST);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error.message).toBe("HTTP 503");
		expect(result.error.retryable).toBe(true);
	});

	it("records a transport failure as the error with code transport", async () => {
		const fake = createFakeTransportV0(() => {
			throw new Error("ECONNRESET");
		});
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		const result = await provider.complete(REQUEST);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error.code).toBe("transport");
		expect(result.error.retryable).toBe(true);
		expect(result.error.message).toBe("ECONNRESET");
	});

	it("throws TypeError for a 2xx body that is not a well-formed completion", async () => {
		const malformed: [string, RegExp][] = [
			["not json", /not valid JSON/],
			[JSON.stringify({ choices: [] }), /empty choices list/],
			[JSON.stringify({ choices: [{ finish_reason: "stop" }] }), /has no message/],
		];
		for (const [body, pattern] of malformed) {
			const fake = createFakeTransportV0(() => ({ status: 200, body }));
			const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
			await expect(provider.complete(REQUEST)).rejects.toThrow(pattern);
		}
	});
});

describe("stream", () => {
	const STREAM_BODY = [
		'data: {"choices":[{"delta":{"role":"assistant"}}]}',
		'data: {"choices":[{"delta":{"content":"Hel"}}]}',
		"",
		'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
		'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
		"data: [DONE]",
	].join("\n");

	it("maps the SSE deltas to the recorded stream in order with a stable id", async () => {
		const request: EndoProviderRequestV0 = { ...REQUEST, stream: true };
		const fake = createFakeTransportV0(() => ({ status: 200, body: STREAM_BODY }));
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		const result = await provider.stream(request);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.stream.requestId).toBe(request.id);
		expect(result.stream.events).toEqual([
			{ sequence: 0, delta: "Hel" },
			{ sequence: 1, delta: "lo" },
		]);
		expect(result.stream.usage).toEqual({
			schemaVersion: "endo.provider-usage.v0",
			inputTokens: 3,
			outputTokens: 2,
			totalTokens: 5,
		});
		expect(result.stream.id).toBe(`endo.evidence.provider-stream.${sha256HexV0(canonicalEndoJsonV0(request))}`);
		expect(validateEndoProviderStreamV0(result.stream)).not.toBeNull();
		expect(JSON.parse(fake.calls[0].body ?? "").stream).toBe(true);
	});

	it("omits the usage when the stream never reported one", async () => {
		const request: EndoProviderRequestV0 = { ...REQUEST, stream: true };
		const body = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\ndata: [DONE]';
		const fake = createFakeTransportV0(() => ({ status: 200, body }));
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		const result = await provider.stream(request);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect("usage" in result.stream).toBe(false);
	});

	it("records non-2xx and transport failures as the error", async () => {
		const request: EndoProviderRequestV0 = { ...REQUEST, stream: true };
		const httpFake = createFakeTransportV0(() => ({ status: 429, body: "{}" }));
		const httpProvider = createEndoOpenAiProviderV0(optionsV0({ transport: httpFake.transport }));
		const httpResult = await httpProvider.stream(request);
		expect(httpResult.ok).toBe(false);
		if (httpResult.ok) throw new Error("unreachable");
		expect(httpResult.error.code).toBe("429");
		expect(httpResult.error.retryable).toBe(true);

		const failFake = createFakeTransportV0(() => {
			throw new Error("socket closed");
		});
		const failProvider = createEndoOpenAiProviderV0(optionsV0({ transport: failFake.transport }));
		const failResult = await failProvider.stream(request);
		expect(failResult.ok).toBe(false);
		if (failResult.ok) throw new Error("unreachable");
		expect(failResult.error.code).toBe("transport");
	});

	it("throws TypeError for a 2xx body that carries no data lines", async () => {
		const request: EndoProviderRequestV0 = { ...REQUEST, stream: true };
		const fake = createFakeTransportV0(() => ({ status: 200, body: COMPLETION_BODY }));
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		await expect(provider.stream(request)).rejects.toThrow(/no data lines/);
	});
});

describe("capabilities", () => {
	it("returns the host declaration with a stable id and no transport call", () => {
		const fake = createFakeTransportV0(() => ({ status: 200, body: "{}" }));
		const provider = createEndoOpenAiProviderV0(
			optionsV0({
				capabilities: { streaming: true, tools: false, vision: false, maxContextTokens: 128000 },
				transport: fake.transport,
			}),
		);
		const record = provider.capabilities();
		expect(record).toEqual({
			schemaVersion: "endo.provider-capabilities.v0",
			id: `endo.evidence.provider-capabilities.${sha256HexV0(
				canonicalEndoJsonV0({
					provider: "openai",
					streaming: true,
					tools: false,
					vision: false,
					maxContextTokens: 128000,
				}),
			)}`,
			provider: "openai",
			streaming: true,
			tools: false,
			vision: false,
			maxContextTokens: 128000,
		});
		expect(validateEndoProviderCapabilitiesV0(record)).not.toBeNull();
		expect(fake.calls).toHaveLength(0);
	});

	it("omits maxContextTokens when the host did not declare one", () => {
		const provider = createEndoOpenAiProviderV0(optionsV0());
		const record = provider.capabilities();
		expect("maxContextTokens" in record).toBe(false);
		expect(isEndoIdentifierV0(record.id, "evidence")).toBe(true);
	});
});

describe("health", () => {
	it("probes GET <endpoint>/models and records the status with a measured latency", async () => {
		const fake = createFakeTransportV0(() => ({ status: 200, body: "{}" }));
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		const record = await provider.health();
		expect(record.latencyMs ?? 0).toBeGreaterThanOrEqual(0);
		expect(record.status).toBe("up");
		expect(Number.isInteger(record.latencyMs)).toBe(true);
		expect(isEndoIdentifierV0(record.id, "evidence")).toBe(true);
		expect(validateEndoProviderHealthV0(record)).not.toBeNull();
		expect(fake.calls[0].method).toBe("GET");
		expect(fake.calls[0].path).toBe(`${ENDPOINT}/models`);
	});

	it("records 4xx as degraded, 5xx as down, and a transport failure as down without latency", async () => {
		for (const [status, expected] of [
			[401, "degraded"],
			[500, "down"],
		] as const) {
			const fake = createFakeTransportV0(() => ({ status, body: "{}" }));
			const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
			const record = await provider.health();
			expect(record.status).toBe(expected);
			expect("latencyMs" in record).toBe(true);
		}
		const failFake = createFakeTransportV0(() => {
			throw new Error("ECONNREFUSED");
		});
		const failProvider = createEndoOpenAiProviderV0(optionsV0({ transport: failFake.transport }));
		const failRecord = await failProvider.health();
		expect(failRecord.status).toBe("down");
		expect("latencyMs" in failRecord).toBe(false);
	});
});

describe("request door", () => {
	it("re-validates the request at the door and throws TypeError on a malformed one", async () => {
		const fake = createFakeTransportV0(() => ({ status: 200, body: COMPLETION_BODY }));
		const provider = createEndoOpenAiProviderV0(optionsV0({ transport: fake.transport }));
		const malformed = { ...REQUEST, schemaVersion: "endo.provider-request.v1" } as unknown as EndoProviderRequestV0;
		await expect(provider.complete(malformed)).rejects.toThrow(TypeError);
		await expect(provider.complete(malformed)).rejects.toThrow(/request failed validation/);
		expect(fake.calls).toHaveLength(0);
	});
});
