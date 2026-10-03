/**
 * The OpenAI-compatible adapter over real HTTP against a local fake endpoint (tests/fixtures/fake-openai-server.ts):
 * the same adapter code path a host uses, with the fetch transport, a socket, SSE framing split across TCP writes,
 * and scripted faults. No credentials, no external network, no model.
 *
 * Streaming semantics, as implemented: the adapter receives the complete SSE body and then parses it, so a stream's
 * events are all available when stream() resolves, never earlier. These tests pin that down rather than claim
 * incremental streaming.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEndoFetchTransportV0 } from "../adapters/provider/fetch-transport.ts";
import { createEndoOpenAiProviderV0 } from "../adapters/provider/openai.ts";
import type { EndoProviderRequestV0 } from "../protocol/provider.ts";
import { validateEndoProviderResponseV0, validateEndoProviderStreamV0 } from "../protocol/provider.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { type FakeOpenAiOptions, type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";

const servers: FakeOpenAiServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function provider(options: FakeOpenAiOptions = {}, endpoint?: string) {
	const server = await startFakeOpenAiServer(options);
	servers.push(server);
	return {
		server,
		provider: createEndoOpenAiProviderV0({
			provider: "fake",
			endpoint: endpoint ?? server.baseUrl,
			apiKey: "local-test-key",
			capabilities: { streaming: true, tools: false, vision: false },
			transport: createEndoFetchTransportV0({ timeoutMs: 10_000 }),
		}),
	};
}

const REQUEST: EndoProviderRequestV0 = {
	schemaVersion: "endo.provider-request.v0",
	id: "endo.evidence.fake-call-1",
	provider: "fake",
	modelId: "fake-1",
	messages: [
		{ role: "system", content: "Be brief." },
		{ role: "user", content: "Hello" },
	],
	maxTokens: 32,
};

describe("OpenAI-compatible adapter against a local endpoint", () => {
	it("sends the documented chat-completions request and decodes the response and usage", async () => {
		const { server, provider: p } = await provider();
		const result = await p.complete(REQUEST);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(validateEndoProviderResponseV0(result.response)).not.toBeNull();
		expect(result.response.content).toBe("Fake reply.");
		expect(result.response.usage).toMatchObject({ inputTokens: 11, outputTokens: 2, totalTokens: 13 });
		expect(server.requests).toHaveLength(1);
		const [sent] = server.requests;
		expect(sent!.method).toBe("POST");
		expect(sent!.url).toBe("/v1/chat/completions");
		expect(sent!.headers.authorization).toBe("Bearer local-test-key");
		expect(sent!.body).toMatchObject({ model: "fake-1", max_tokens: 32, messages: REQUEST.messages });
	});

	it("decodes SSE split across TCP writes in order, with usage, only once the body is complete", async () => {
		const { provider: p } = await provider({ splitWrites: true, chunkMs: 2 });
		const request = { ...REQUEST, stream: true, messages: [{ role: "user" as const, content: "count to forty" }] };
		const result = await p.stream(request);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(validateEndoProviderStreamV0(result.stream)).not.toBeNull();
		expect(result.stream.events).toHaveLength(40);
		expect(result.stream.events.map((event) => event.sequence)).toEqual([...Array(40).keys()]);
		expect(result.stream.events[0]!.delta).toBe("1. word\n");
		expect(result.stream.events[39]!.delta).toBe("40. word\n");
		expect(result.stream.usage).toMatchObject({ inputTokens: 11, outputTokens: 40, totalTokens: 51 });
	});

	it("omits usage the endpoint did not report instead of inventing zeros", async () => {
		const { provider: p } = await provider({ omitUsage: true });
		const result = await p.stream({ ...REQUEST, stream: true });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.stream.usage).toBeUndefined();
	});

	it("throws on a 2xx stream with a malformed data line rather than recording a fabricated outcome", async () => {
		const { provider: p } = await provider({ malformedStream: true });
		await expect(p.stream({ ...REQUEST, stream: true })).rejects.toThrow(TypeError);
	});

	it.each([
		[429, true],
		[500, true],
		[503, true],
		[400, false],
		[401, false],
	])("records HTTP %i as an error with retryable=%s", async (status, retryable) => {
		const { provider: p } = await provider({
			failWith: { status, body: JSON.stringify({ error: { message: "scripted" } }) },
		});
		const result = await p.complete(REQUEST);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe(String(status));
		expect(result.error.retryable).toBe(retryable);
	});

	it("records a refused connection as a retryable transport error", async () => {
		const { server } = await provider();
		const dead = server.baseUrl;
		await server.close();
		servers.splice(servers.indexOf(server), 1);
		const p = createEndoOpenAiProviderV0({
			provider: "fake",
			endpoint: dead,
			apiKey: "",
			capabilities: { streaming: true, tools: false, vision: false },
			transport: createEndoFetchTransportV0({ timeoutMs: 2_000 }),
		});
		const result = await p.complete(REQUEST);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("transport");
			expect(result.error.retryable).toBe(true);
		}
	});

	it("gives the same request the same content-addressed outcome id, and a retry a new one", async () => {
		const { provider: p } = await provider();
		const first = await p.complete(REQUEST);
		const again = await p.complete(REQUEST);
		const retry = await p.complete({ ...REQUEST, id: "endo.evidence.fake-call-2" });
		if (!first.ok || !again.ok || !retry.ok) throw new Error("expected completions");
		expect(first.response.id).toBe(`endo.evidence.provider-response.${sha256HexV0(canonicalEndoJsonV0(REQUEST))}`);
		expect(again.response.id).toBe(first.response.id);
		expect(retry.response.id).not.toBe(first.response.id);
	});
});
