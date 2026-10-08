// The harness surface under real scheduling: two client connections to the recording proxy where the request with the
// earlier exchange number is recorded LATER (its body is delayed), so the capture log's event order is not the
// exchange order. The producer (exchange order, cli/experiment-surface.ts) and the validator
// (protocol/experiment-artifacts.ts) must agree on the trial that results, and the capture log itself is left as the
// proxy wrote it. Self-contained: a loopback fake upstream, a scratch key, no Pi, no network.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EndoCaptureLogV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../adapters/openai-proxy/cassette.ts";
import { harnessSurfacesOfCaptureV0 } from "../adapters/openai-proxy/harness-surface.ts";
import { startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { buildEndoTrialHarnessV0, requestParametersOfTrialV0 } from "../cli/experiment-surface.ts";
import { type EndoExperimentTrialResultV1, readEndoExperimentTrialResultV0 } from "../protocol/experiment-artifacts.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";

const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
const FIXTURES = join(import.meta.dirname, "fixtures", "schema-compat");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const body = (temperature: number) =>
	JSON.stringify({
		model: "model-a",
		stream: false,
		temperature,
		messages: [
			{ role: "system", content: "You are a coding agent." },
			{ role: "user", content: `task for ${temperature}` },
		],
		tools: [],
	});

describe("harness surface derivation under concurrent connections", () => {
	it("a request with the earlier exchange recorded later still gives a trial its own validator accepts", async () => {
		const upstream: Server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 2 });
				res.end("{}");
			});
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
		const store = mkdtempSync(join(tmpdir(), "endo-surface-concurrent-"));
		cleanup.push(() => rmSync(store, { recursive: true, force: true }));
		const log = new EndoCaptureLogV0(store, key, "record", { async: true });
		const proxy = await startEndoRecordingProxyV0({
			upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
			log,
		});
		cleanup.push(async () => {
			await proxy.close();
			log.close();
		});

		// A: the head arrives first (exchange 1), but its body is held back.
		const early = body(0.1);
		const late = body(0.9);
		const a = connect(proxy.port, "127.0.0.1");
		a.on("error", () => {});
		let answered = "";
		const aResponse = new Promise<void>((resolve) =>
			a.on("data", (chunk) => {
				answered += chunk.toString("latin1");
				if (answered.endsWith("{}")) resolve();
			}),
		);
		a.write(
			`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(early)}\r\nConnection: close\r\n\r\n${early.slice(0, 20)}`,
		);
		for (let i = 0; i < 100 && proxy.open < 1; i++) await sleep(10);
		expect(proxy.open).toBe(1);

		// B: a whole request on its own connection (exchange 2), answered and closed before A's body completes.
		await new Promise<void>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: proxy.port,
					method: "POST",
					path: "/v1/chat/completions",
					headers: { "Content-Type": "application/json", Connection: "close" },
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve());
				},
			);
			req.on("error", reject);
			req.end(late);
		});
		await sleep(150);
		await proxy.flush();
		expect(
			readEndoCaptureEventsV0(store)
				.filter((event) => event.kind === "capture.request")
				.map((event) => (event.payload as { exchange: number }).exchange),
		).toEqual([2]);

		// A's body completes: exchange 1 is recorded after exchange 2.
		a.write(early.slice(20));
		await aResponse;
		a.end();
		await proxy.flush();
		const requests = readEndoCaptureEventsV0(store).filter((event) => event.kind === "capture.request");
		const logged = requests.map((event) => event.payload as { exchange: number; requestDigest: { value: string } });
		expect(logged.map((p) => p.exchange)).toEqual([2, 1]);

		// The surfaces come out in event order; the trial is built in exchange order.
		const surfaces = harnessSurfacesOfCaptureV0(store, key);
		expect(surfaces.map((s) => s.source.exchange)).toEqual([2, 1]);
		const trial: EndoExperimentTrialResultV1 = {
			...(JSON.parse(
				readFileSync(join(FIXTURES, "endo.experiment-trial.v1", "minimal.json"), "utf8"),
			) as EndoExperimentTrialResultV1),
			harness: buildEndoTrialHarnessV0(surfaces, {
				workingDirectory: { status: "reported", value: "/w", source: "runner" },
				invocationMode: { status: "reported", value: "pi --mode rpc", source: "runner" },
				configuredModel: { status: "reported", value: "p/model-a", source: "spec" },
			}),
		};
		expect(readEndoExperimentTrialResultV0(trial).ok).toBe(true);
		expect(trial.harness.requests.map((r) => r.exchange)).toEqual([1, 2]);
		expect(trial.harness.surfaces.map((s) => s.source.exchange)).toEqual([1, 2]);
		// Each surface's source is the request it came from, not its neighbour.
		const digestOf = (exchange: number) => logged.find((p) => p.exchange === exchange)!.requestDigest.value;
		for (const surface of trial.harness.surfaces)
			expect(surface.source.requestDigest).toBe(digestOf(surface.source.exchange));
		// The logical order is deterministic: the parameters come out in exchange order.
		expect(requestParametersOfTrialV0(trial).map((p) => (p as { temperature: number }).temperature)).toEqual([
			0.1, 0.9,
		]);

		// Externally supplied order that disagrees with exchange order is still refused, never reordered on read.
		const swapped = { ...trial, harness: { ...trial.harness, requests: [...trial.harness.requests].reverse() } };
		expect(readEndoExperimentTrialResultV0(swapped).ok).toBe(false);

		// The capture log and replay are as the proxy wrote them: event order untouched, the cassette still loads.
		expect(
			readEndoCaptureEventsV0(store)
				.filter((event) => event.kind === "capture.request")
				.map((event) => (event.payload as { exchange: number }).exchange),
		).toEqual([2, 1]);
		expect(() => loadEndoCassetteV0(store, key)).not.toThrow();
	});
});
