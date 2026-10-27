import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import { startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";

describe("governed recording proxy admission", () => {
	it("does not forward partial, unapproved, or repeated requests", async () => {
		const root = mkdtempSync(join(tmpdir(), "endo-proxy-admission-"));
		const upstream = await startFakeOpenAiServer();
		const log = new EndoCaptureLogV0(root, endoDigestKeyV0(Buffer.alloc(32, 7), "proxy-test"), "record");
		let permits = 0;
		const proxy = await startEndoRecordingProxyV0({
			upstream: new URL(upstream.baseUrl).origin,
			log,
			maxTransferredBytes: 64 * 1024,
			admitRequest: ({ method, path, body }) => {
				if (permits !== 1 || method !== "POST" || path !== "/v1/chat/completions") return false;
				if (JSON.parse(Buffer.from(body).toString()).model !== "fake-1") return false;
				permits = 0;
				return true;
			},
		});
		const request = () =>
			fetch(`${proxy.origin}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "fake-1", messages: [{ role: "user", content: "hello" }] }),
			});
		try {
			await expect(request()).rejects.toThrow();
			expect(upstream.requests).toHaveLength(0);
			permits = 1;
			const response = await request();
			expect(response.status).toBe(200);
			await response.text();
			expect(upstream.requests).toHaveLength(1);
			await expect(request()).rejects.toThrow();
			expect(upstream.requests).toHaveLength(1);

			// A head and partial body cannot open an upstream connection while the policy waits for the full body.
			permits = 1;
			const socket = connect(proxy.port, proxy.host);
			await new Promise<void>((resolve) => socket.once("connect", resolve));
			socket.write("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{");
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(upstream.requests).toHaveLength(1);
			socket.destroy();
			expect(proxy.refusedRequests).toBe(2);
		} finally {
			await proxy.close();
			log.close();
			await upstream.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
