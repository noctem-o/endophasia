// A local, deterministic OpenAI-compatible endpoint for tests: POST /v1/chat/completions (JSON or SSE) and
// GET /v1/models. No credentials, no external network, no model. It serves both the Endophasia provider adapter tests
// and the opt-in real-Pi acceptance test (Pi's `openai-completions` API pointed at it through models.json).
//
// Replies are scripted: a request whose last user message asks for "the read tool" gets a read tool call first (when
// the request offers tools), then a short text once the tool result is present; a "forty" request streams slowly so a
// steer, follow-up or abort can land mid-run. Faults are configured per server.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOpenAiOptions {
	/** Delay between SSE chunks. Default 5 ms; "forty" requests use `slowChunkMs` (default 60 ms). */
	readonly chunkMs?: number;
	readonly slowChunkMs?: number;
	/** Respond to every chat request with this status and body instead of a completion. */
	readonly failWith?: { status: number; body: string };
	/** Send a 200 SSE body containing a malformed data line. */
	readonly malformedStream?: boolean;
	/** Omit the usage chunk. */
	readonly omitUsage?: boolean;
	/** Write each SSE event split across several TCP writes. */
	readonly splitWrites?: boolean;
}

export interface FakeOpenAiRequestLog {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	readonly body: unknown;
}

export interface FakeOpenAiServer {
	readonly baseUrl: string;
	readonly requests: FakeOpenAiRequestLog[];
	close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function lastUserText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown; content?: unknown };
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content))
			return message.content
				.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
				.join("");
	}
	return "";
}

export async function startFakeOpenAiServer(options: FakeOpenAiOptions = {}): Promise<FakeOpenAiServer> {
	const requests: FakeOpenAiRequestLog[] = [];
	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		let body: unknown = null;
		try {
			body = raw.length === 0 ? null : JSON.parse(raw);
		} catch {
			body = raw;
		}
		requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
		if (request.method === "GET" && request.url?.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: [{ id: "fake-1", object: "model" }] }));
			return;
		}
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (options.failWith !== undefined) {
			response.writeHead(options.failWith.status, { "content-type": "application/json" });
			response.end(options.failWith.body);
			return;
		}
		const parsed = (typeof body === "object" && body !== null ? body : {}) as {
			model?: string;
			stream?: boolean;
			messages?: unknown[];
			tools?: unknown[];
		};
		const model = parsed.model ?? "fake-1";
		const text = lastUserText(parsed.messages);
		const hasToolResult =
			Array.isArray(parsed.messages) && parsed.messages.some((m) => (m as { role?: unknown }).role === "tool");
		const callTool =
			/read tool/.test(text) && Array.isArray(parsed.tools) && parsed.tools.length > 0 && !hasToolResult;
		const slow = /forty/.test(text);
		const pieces = slow
			? Array.from({ length: 40 }, (_, index) => `${index + 1}. word\n`)
			: hasToolResult
				? ["Endophasia"]
				: ["Fake ", "reply."];
		const usage = { prompt_tokens: 11, completion_tokens: pieces.length, total_tokens: 11 + pieces.length };
		const id = "chatcmpl-fake";
		if (parsed.stream !== true) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					id,
					object: "chat.completion",
					created: 1,
					model,
					choices: [{ index: 0, message: { role: "assistant", content: pieces.join("") }, finish_reason: "stop" }],
					usage,
				}),
			);
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const write = async (payload: string) => {
			const event = `data: ${payload}\n\n`;
			if (options.splitWrites) {
				for (let offset = 0; offset < event.length; offset += 7) response.write(event.slice(offset, offset + 7));
			} else response.write(event);
		};
		const chunk = (delta: Record<string, unknown>, finish: string | null) =>
			JSON.stringify({
				id,
				object: "chat.completion.chunk",
				created: 1,
				model,
				choices: [{ index: 0, delta, finish_reason: finish }],
			});
		const delay = slow ? (options.slowChunkMs ?? 60) : (options.chunkMs ?? 5);
		if (options.malformedStream) {
			await write(chunk({ role: "assistant", content: "ok" }, null));
			await write("{not json");
			response.end();
			return;
		}
		if (callTool) {
			await write(
				chunk(
					{
						role: "assistant",
						tool_calls: [
							{ index: 0, id: "call_fake_1", type: "function", function: { name: "read", arguments: "" } },
						],
					},
					null,
				),
			);
			await sleep(delay);
			await write(
				chunk(
					{
						tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "endophasia-study.txt" }) } }],
					},
					"tool_calls",
				),
			);
		} else {
			for (const [index, piece] of pieces.entries()) {
				if (response.destroyed) return;
				await write(chunk(index === 0 ? { role: "assistant", content: piece } : { content: piece }, null));
				await sleep(delay);
			}
			await write(chunk({}, "stop"));
		}
		if (!options.omitUsage) {
			await write(JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [], usage }));
		}
		response.write("data: [DONE]\n\n");
		response.end();
	};
	const server: Server = createServer((request, response) => {
		handle(request, response).catch(() => {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}
