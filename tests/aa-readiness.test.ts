import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	awaitTaskOwnedReadinessV0,
	isHealthyBodyV0,
	READINESS_MAX_BODY_BYTES_V0,
	type ReadinessOptionsV0,
} from "../research/governed-initial-continuation/aa/task-owned-readiness.ts";

type Reply = (response: ServerResponse, request: IncomingMessage) => void;
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});
/** A server that answers each GET with the next scripted reply, repeating the last. Every request is logged. */
async function serve(replies: Reply[]) {
	const log: string[] = [];
	let index = 0;
	const server = createServer((request, response) => {
		log.push(`${request.method} ${request.url}`);
		const reply = replies[Math.min(index++, replies.length - 1)]!;
		reply(response, request);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return { log, endpoint: `http://127.0.0.1:${port}` };
}
const json =
	(status: number, body: string): Reply =>
	(response) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(body);
	};
const ok = json(200, '{"status":"ok"}');
const loading = json(503, '{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}');
const options = (extra: Partial<ReadinessOptionsV0> = {}): ReadinessOptionsV0 => ({
	timeoutMs: 3000,
	signal: new AbortController().signal,
	verifyIdentity: async () => true,
	recheckIdentity: () => true,
	pollIntervalMs: 10,
	...extra,
});

describe("llama.cpp readiness gate", () => {
	it("keeps polling through HTTP 503 and is ready on 200 with exactly {status: ok}", async () => {
		const { endpoint, log } = await serve([loading, loading, loading, ok]);
		expect(await awaitTaskOwnedReadinessV0(endpoint, options())).toEqual({
			status: "ready",
			polls: 4,
			loadingResponses: 3,
		});
		// Only the documented health route, only GET: no completion, no model listing, no POST.
		expect(log).toEqual(Array(4).fill("GET /health"));
	});
	it("is ready immediately when the first answer is healthy", async () => {
		const { endpoint } = await serve([ok]);
		expect(await awaitTaskOwnedReadinessV0(endpoint, options())).toMatchObject({
			status: "ready",
			polls: 1,
			loadingResponses: 0,
		});
	});
	it.each([
		["not found", json(404, "{}"), "unexpected-status"],
		["a server error", json(500, "{}"), "unexpected-status"],
		["no content", json(204, ""), "unexpected-status"],
		["a wrong status", json(200, '{"status":"loading"}'), "invalid-body"],
		["an extra field", json(200, '{"status":"ok","slots_idle":1}'), "invalid-body"],
		["a nested status", json(200, '{"status":{"state":"ok"}}'), "invalid-body"],
		["an array", json(200, '[{"status":"ok"}]'), "invalid-body"],
		["text", json(200, "ok"), "invalid-body"],
		["an empty body", json(200, ""), "invalid-body"],
	] as const)("refuses %s", async (_name, reply, reason) => {
		const { endpoint } = await serve([reply]);
		expect(await awaitTaskOwnedReadinessV0(endpoint, options())).toMatchObject({ status: "refused", reason });
	});
	it.each([301, 302, 303, 307, 308])("refuses a %i redirect and never follows it", async (status) => {
		const target = await serve([ok]);
		const { endpoint } = await serve([
			(response) => {
				response.writeHead(status, { location: `${target.endpoint}/health` });
				response.end();
			},
		]);
		expect(await awaitTaskOwnedReadinessV0(endpoint, options())).toMatchObject({
			status: "refused",
			reason: "redirect",
		});
		expect(target.log).toEqual([]);
	});
	it("refuses an oversized body, declared or streamed", async () => {
		const huge = "x".repeat(READINESS_MAX_BODY_BYTES_V0 + 1);
		const declared = await serve([json(200, huge)]);
		expect(await awaitTaskOwnedReadinessV0(declared.endpoint, options())).toMatchObject({
			reason: "oversized-response",
		});
		const streamed = await serve([
			(response) => {
				response.writeHead(503, { "content-type": "application/json" }); // No content-length: chunked.
				response.write(huge.slice(0, 3000));
				response.write(huge.slice(0, 3000));
				response.end();
			},
		]);
		expect(await awaitTaskOwnedReadinessV0(streamed.endpoint, options())).toMatchObject({
			reason: "oversized-response",
		});
	});
	it("refuses a dropped connection, a refused connection and a reply that never arrives", async () => {
		const dropped = await serve([(response) => response.socket?.destroy()]);
		expect(await awaitTaskOwnedReadinessV0(dropped.endpoint, options())).toMatchObject({ reason: "network-failure" });
		const closed = await serve([ok]);
		servers[servers.length - 1]!.close();
		servers[servers.length - 1]!.closeAllConnections();
		expect(await awaitTaskOwnedReadinessV0(closed.endpoint, options())).toMatchObject({ status: "refused" });
		const silent = await serve([() => {}]);
		const started = performance.now();
		// A request that times out is a network failure; the whole wait still ends well inside its deadline.
		const hung = await awaitTaskOwnedReadinessV0(silent.endpoint, options({ timeoutMs: 400, requestTimeoutMs: 200 }));
		expect(hung.status).toBe("refused");
		expect(["network-failure", "deadline-exceeded"]).toContain((hung as { reason: string }).reason);
		expect(performance.now() - started).toBeLessThan(2000);
	});
	it("has a strict deadline even when the server only ever says it is loading", async () => {
		const { endpoint } = await serve([loading]);
		const started = performance.now();
		const outcome = await awaitTaskOwnedReadinessV0(endpoint, options({ timeoutMs: 500 }));
		expect(outcome).toMatchObject({ status: "refused", reason: "deadline-exceeded" });
		expect(outcome.loadingResponses).toBeGreaterThan(5);
		expect(performance.now() - started).toBeLessThan(1500);
	});
	it("enforces the deadline against a healthy answer that is trickled in slowly", async () => {
		// Each chunk arrives well inside the inactivity timeout, but the whole answer takes far longer than the deadline.
		const { endpoint } = await serve([
			(response) => {
				response.writeHead(200, { "content-type": "application/json" });
				const body = '{"status":"ok"}';
				let i = 0;
				const timer = setInterval(() => {
					if (i < body.length) response.write(body[i++]);
					else {
						clearInterval(timer);
						response.end();
					}
				}, 40);
				response.on("close", () => clearInterval(timer));
			},
		]);
		const started = performance.now();
		const outcome = await awaitTaskOwnedReadinessV0(endpoint, options({ timeoutMs: 100, requestTimeoutMs: 3000 }));
		expect(outcome.status).toBe("refused");
		expect(["deadline-exceeded", "network-failure"]).toContain((outcome as { reason: string }).reason);
		expect(performance.now() - started).toBeLessThan(400);
	});
	it("honours cancellation before and during the wait", async () => {
		const { endpoint, log } = await serve([loading]);
		const early = new AbortController();
		early.abort();
		expect(await awaitTaskOwnedReadinessV0(endpoint, options({ signal: early.signal }))).toMatchObject({
			reason: "cancelled",
			polls: 0,
		});
		expect(log).toEqual([]);
		const late = new AbortController();
		setTimeout(() => late.abort(), 100);
		expect(
			await awaitTaskOwnedReadinessV0(endpoint, options({ signal: late.signal, timeoutMs: 5000 })),
		).toMatchObject({ reason: "cancelled" });
	});
	it("refuses when the owned server's identity cannot be confirmed before, between or after the answers", async () => {
		const before = await serve([ok]);
		expect(
			await awaitTaskOwnedReadinessV0(before.endpoint, options({ verifyIdentity: async () => false })),
		).toMatchObject({
			reason: "identity-changed",
			polls: 0,
		});
		expect(before.log).toEqual([]);
		const between = await serve([loading]);
		expect(
			await awaitTaskOwnedReadinessV0(between.endpoint, options({ recheckIdentity: () => false })),
		).toMatchObject({ reason: "identity-changed" });
		// A healthy answer followed by an identity change is not readiness.
		const after = await serve([ok]);
		let calls = 0;
		expect(
			await awaitTaskOwnedReadinessV0(after.endpoint, options({ verifyIdentity: async () => ++calls === 1 })),
		).toMatchObject({ status: "refused", reason: "identity-changed", polls: 1 });
	});
	it.each([
		"http://localhost:8080",
		"http://[::1]:8080",
		"http://127.0.0.2:8080",
		"https://127.0.0.1:8080",
		"http://127.0.0.1:8080/",
		"http://127.0.0.1:8080/health",
		"http://user@127.0.0.1:8080",
		"http://127.0.0.1:80",
		"http://127.0.0.1:99999",
		"http://example.com:8080",
	])("rejects the endpoint %s before any request", async (endpoint) => {
		await expect(awaitTaskOwnedReadinessV0(endpoint, options())).rejects.toThrow("unsupported readiness request");
	});
	it("requires a bounded wait", async () => {
		const { endpoint } = await serve([ok]);
		for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 600001, Number.NaN])
			await expect(awaitTaskOwnedReadinessV0(endpoint, options({ timeoutMs }))).rejects.toThrow(
				"unsupported readiness request",
			);
	});
	it("accepts exactly the documented body", () => {
		for (const good of ['{"status":"ok"}', ' {"status" : "ok"}\n'])
			expect(isHealthyBodyV0(Buffer.from(good))).toBe(true);
		for (const bad of [
			"",
			"{}",
			'{"status":"OK"}',
			'{"status":"ok","a":1}',
			'{"status":["ok"]}',
			"null",
			'"ok"',
			"\xff\xfe",
		])
			expect(isHealthyBodyV0(Buffer.from(bad, "latin1"))).toBe(false);
	});
});
