// COORDINATOR-MODEL-POOL-001 (M1) acceptance tests: docs/designs/coordinator-model-pool-m1-implementation.md §6.
// Every endpoint here is a deterministic fake on an ephemeral 127.0.0.1 port; nothing contacts a real model server.

import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkCoordinatorModelPoolV0,
	ENDO_COORDINATOR_M0_POOL_V0,
	pooledCoordinatorV0,
	readCoordinatorModelPoolFileV0,
} from "../adapters/coordinator/model-pool.ts";
import { probeLocalEndpointV0 } from "../adapters/coordinator/model-pool-probe.ts";
import {
	coordinatorInferenceForV0,
	coordinatorRelayPolicyV0,
	coordinatorTargetFromMemberV0,
	ENDO_COORDINATOR_M0_TARGET_V0,
	type EndoCoordinatorModelTargetV0,
	startCoordinatorModelRelayV0,
} from "../adapters/coordinator/model-relay.ts";
import { runOpenClawCoordinatorV0 } from "../adapters/coordinator/openclaw.ts";
import { COORDINATOR_ENV_V0, coordinatorBwrapV0 } from "../adapters/coordinator/status.ts";
import { COORDINATOR_INFERENCE_V0, coordinatorWireV0 } from "../adapters/coordinator/wire.ts";
import { EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import { modelRelayPolicyDigestV0 } from "../adapters/sandbox/model-relay-policy.ts";
import {
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
	endoCoordinatorLoopbackOriginV0,
	parseEndoCoordinatorModelPoolV0,
} from "../protocol/coordinator-model-pool.ts";
import {
	briefFromCoordinatorSubstrateV0,
	ENDO_COORDINATOR_TOOL_DEFINITION_V0,
	ENDO_COORDINATOR_TOOL_V0,
	type EndoCoordinatorBriefResultV0,
} from "../runtime/contracts/coordinator-brief.ts";
import {
	type EndoCoordinatorMemberObservationV0,
	selectCoordinatorModelV0,
} from "../runtime/contracts/coordinator-model-pool.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { createBriefFixtureV0, fixtureManifestV0 } from "./coordinator-brief-fixtures.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const projectId = `endo.project.${"a".repeat(32)}`;
const other = `endo.project.${"b".repeat(32)}`;

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "endo-pool-"));
	dirs.push(dir);
	return dir;
};
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const close of closers.splice(0)) await close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Hit {
	readonly method: string;
	readonly url: string;
	readonly authorization: string | undefined;
}
interface Fake {
	readonly origin: string;
	readonly port: number;
	readonly hits: Hit[];
	connections: number;
}

async function fake(
	handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
	host = "127.0.0.1",
	port = 0,
): Promise<Fake> {
	const state = { hits: [] as Hit[], connections: 0 };
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		state.hits.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
		handler(req, res, Buffer.concat(chunks).toString("utf8"));
	});
	server.on("connection", () => {
		state.connections += 1;
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});
	closers.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address() as AddressInfo;
	const result = {
		origin: `http://127.0.0.1:${address.port}`,
		port: address.port,
		hits: state.hits,
		get connections() {
			return state.connections;
		},
		set connections(_v: number) {},
	};
	return result;
}

/** A closed port: listen, read the port, close. */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

type ModelStatus = "loaded" | "loading" | "unloaded" | "sleeping" | "downloading" | "failed";

/**
 * A fake llama.cpp server. In router mode it behaves as server-models.cpp does for the routes the probe must avoid: a GET with
 * `?model=` or any `/slots`, and any POST, would load the model (counted in `loads`).
 */
function llama(options: {
	mode: "router" | "single" | "openai";
	health?: 200 | 500 | "loading";
	models?: Record<string, ModelStatus>;
	sleeping?: boolean | null;
	slots?: number;
	listing?: number;
	state?: { loads: number; completions: number };
}) {
	const state = options.state ?? { loads: 0, completions: 0 };
	const models = options.models ?? { "model-a": "loaded" };
	return {
		state,
		handler: (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", "http://x");
			const send = (status: number, value: unknown) => {
				res.statusCode = status;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(value));
			};
			if (req.method !== "GET") {
				state.completions += 1;
				state.loads += 1;
				return send(500, { error: "completion requested by a probe" });
			}
			if (url.searchParams.has("model") || url.searchParams.has("autoload") || url.searchParams.has("reload"))
				state.loads += 1;
			if (url.pathname === "/health") {
				if (options.health === "loading")
					return send(503, { error: { code: 503, message: "Loading model", type: "unavailable_error" } });
				if (options.health === 500) return send(500, { error: "broken" });
				return send(200, { status: "ok" });
			}
			if (url.pathname === "/props") {
				if (options.mode === "openai") return send(404, { error: "not found" });
				if (options.mode === "router") return send(200, { role: "router", build_info: "b12622-19bc41dbb" });
				return send(200, {
					build_info: "b12622-19bc41dbb",
					...(options.sleeping === null || options.sleeping === undefined
						? {}
						: { is_sleeping: options.sleeping }),
				});
			}
			if (url.pathname === "/models" || url.pathname === "/v1/models") {
				if (options.mode === "openai" && url.pathname === "/models") return send(404, {});
				if (options.listing !== undefined && options.listing !== 200) return send(options.listing, {});
				return send(200, {
					object: "list",
					data: Object.entries(models).map(([id, status]) => ({
						id,
						object: "model",
						...(options.mode === "router"
							? {
									status:
										status === "failed"
											? { value: "unloaded", failed: true, exit_code: 1 }
											: { value: status, args: ["llama-server"] },
								}
							: {}),
					})),
				});
			}
			if (url.pathname === "/slots") {
				if (options.mode === "router") state.loads += 1;
				if (url.searchParams.get("fail_on_no_slot") !== "1") return send(400, {});
				return send(
					options.slots ?? 200,
					options.slots === 503 ? { error: "no slot" } : [{ id: 0, is_processing: false }],
				);
			}
			send(404, {});
		},
	};
}

const local = (memberId: string, endpoint: string, over: Record<string, unknown> = {}) => ({
	memberId,
	kind: "local-openai-compat",
	endpoint,
	modelId: "model-a",
	priority: 10,
	maxPromptBytes: 8192,
	maxOutputTokens: 2048,
	timeoutMs: 135_000,
	advisoryOnly: true,
	...over,
});
const doc = (
	members: unknown[],
	selection: Record<string, unknown> = { fallback: "availability", unconfirmedModel: "refuse" },
) => ({ schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0, selection, members });
const poolOf = (members: unknown[], selection?: Record<string, unknown>) =>
	parseEndoCoordinatorModelPoolV0(doc(members, selection));

const observation = (memberId: string, endpoint: string, readiness: EndoCoordinatorMemberObservationV0["readiness"]) =>
	({
		memberId,
		endpoint,
		modelId: "model-a",
		basis: "controller-observed",
		observedAtMs: 1,
		elapsedMs: 0,
		readiness,
		detail: "slot-idle",
		backend: "llama.cpp-single",
		build: null,
		requests: [],
		inferenceTokens: 0,
	}) as EndoCoordinatorMemberObservationV0;

/** Run the CLI without blocking this process's event loop, so the fakes it contacts can answer. */
function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) =>
			resolve({ status: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout, stderr }),
		);
	});
}

type Run = typeof runOpenClawCoordinatorV0;
/** A stand-in for the M0 runner: records what it was given; answers as told. */
function fakeRun(
	answer: (target: EndoCoordinatorModelTargetV0) => Partial<EndoCoordinatorBriefResultV0> | null = () => null,
) {
	const calls: { target: EndoCoordinatorModelTargetV0; provider: string | undefined }[] = [];
	const run: Run = async (_root, request, options = {}) => {
		const target = options.target as EndoCoordinatorModelTargetV0;
		calls.push({ target, provider: options.provider });
		options.trial?.({
			promptSha256: "0".repeat(64),
			inference: coordinatorInferenceForV0(target),
			wire: {
				toolDefinitions: [],
				statusDelivered: true,
				statusMessage: null,
				inference: [],
				responses: [
					{
						finish: "tool_calls",
						usage: { prompt_tokens: 100, completion_tokens: 10 },
						text: "",
						toolCalled: true,
					},
					{ finish: "stop", usage: { prompt_tokens: 300, completion_tokens: 40 }, text: "x", toolCalled: false },
				],
				refusal: null,
			},
			dispatched: true,
			toolOutcome: null,
			evidence: { readAtMs: 1, projectionSha256: "a".repeat(64), modelViewSha256: "b".repeat(64) },
			latencyMs: 20,
			inferenceElapsedMs: 12,
			recorderClean: true,
			stderr: "",
		});
		const base = {
			schemaVersion: "endo.coordinator-brief.v0" as const,
			projectId: request.projectId,
			runtime: { harness: "OpenClaw 2026.11.7", provider: options.provider ?? "?", model: target.model },
		};
		const override = answer(target);
		return {
			...base,
			availability: "available",
			answer: "The operator put one task in review.",
			evidence: { readAtMs: 1, projectionSha256: "a".repeat(64), modelViewSha256: "b".repeat(64) },
			toolSurface: [ENDO_COORDINATOR_TOOL_V0],
			...(override ?? {}),
		} as EndoCoordinatorBriefResultV0;
	};
	return { run, calls };
}

describe("M1-AT02 configuration validation, before any endpoint is contacted", () => {
	const base = (over: Record<string, unknown> = {}) => local("primary", "http://127.0.0.1:8091", over);
	it.each([
		["not an object", []],
		["unknown schema", { ...doc([base()]), schemaVersion: "endo.coordinator-model-pool.v1" }],
		["unknown top-level field", { ...doc([base()]), hosted: true }],
		["missing selection", { schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0, members: [base()] }],
		["unknown fallback", doc([base()], { fallback: "any", unconfirmedModel: "refuse" })],
		["selection extra field", doc([base()], { fallback: "none", unconfirmedModel: "refuse", retry: 3 })],
		["no members", doc([])],
		["too many members", doc(Array.from({ length: 17 }, (_, i) => base({ memberId: `m${i}`, modelId: `m${i}` })))],
		["duplicate memberId", doc([base(), base({ modelId: "model-b" })])],
		["same endpoint and model", doc([base(), base({ memberId: "secondary" })])],
		["uppercase memberId", doc([base({ memberId: "Primary" })])],
		["memberId trailing hyphen", doc([base({ memberId: "primary-" })])],
		["unsupported kind", doc([base({ kind: "openrouter" })])],
		["advisoryOnly false", doc([base({ advisoryOnly: false })])],
		["advisoryOnly missing", doc([(({ advisoryOnly: _, ...m }) => m)(base())])],
		["credential field", doc([base({ apiKey: "sk-test" })])],
		[
			"prototype key",
			JSON.parse(
				`{"schemaVersion":"${ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0}","selection":{"fallback":"none","unconfirmedModel":"refuse"},"members":[],"__proto__":{}}`,
			),
		],
		["priority negative", doc([base({ priority: -1 })])],
		["priority fractional", doc([base({ priority: 1.5 })])],
		["priority as string", doc([base({ priority: "10" })])],
		["prompt bytes above M0", doc([base({ maxPromptBytes: 8193 })])],
		["prompt bytes too small", doc([base({ maxPromptBytes: 10 })])],
		["output tokens above M0", doc([base({ maxOutputTokens: 4096 })])],
		["output tokens zero", doc([base({ maxOutputTokens: 0 })])],
		["timeout above M0", doc([base({ timeoutMs: 600_000 })])],
		["timeout too short", doc([base({ timeoutMs: 10 })])],
		["model id with space", doc([base({ modelId: "model a" })])],
		["empty model id", doc([base({ modelId: "" })])],
		["hosted relay over http", doc([base({ kind: "hosted-relay", endpoint: "http://openrouter.ai" })])],
		["hosted relay with path", doc([base({ kind: "hosted-relay", endpoint: "https://openrouter.ai/api/v1" })])],
		["hosted relay with credentials", doc([base({ kind: "hosted-relay", endpoint: "https://key@openrouter.ai" })])],
	])("refuses %s", (_name, value) => {
		expect(() => parseEndoCoordinatorModelPoolV0(value)).toThrow(TypeError);
	});

	it("accepts a valid pool and returns a frozen copy holding only declared fields", () => {
		const pool = poolOf([base(), local("secondary", "http://127.0.0.1:8092", { priority: 5 })]);
		expect(Object.isFrozen(pool) && Object.isFrozen(pool.members[0])).toBe(true);
		expect(pool.members.map((m) => m.memberId)).toEqual(["primary", "secondary"]);
	});

	it("refuses unsafe pool files with a diagnostic and never connects to the member", async () => {
		const server = await fake((_q, s) => s.end("{}"));
		const dir = scratch();
		const valid = JSON.stringify(doc([local("primary", server.origin)]));
		const put = (name: string, text: string) => {
			writeFileSync(join(dir, name), text);
			return join(dir, name);
		};
		const cases: [string, () => string, RegExp][] = [
			["missing", () => join(dir, "none.json"), /cannot be opened/],
			[
				"directory",
				() => {
					mkdirSync(join(dir, "d"));
					return join(dir, "d");
				},
				/not a regular file/,
			],
			[
				"symbolic link",
				() => {
					symlinkSync(put("real.json", valid), join(dir, "link.json"));
					return join(dir, "link.json");
				},
				/cannot be opened/,
			],
			["oversized", () => put("big.json", `${" ".repeat(70_000)}${valid}`), /64 KiB/],
			["not JSON", () => put("bad.json", "{"), /not JSON/],
			[
				"repeated key",
				() => put("dup.json", valid.replace('"modelId":"model-a"', '"modelId":"model-a","modelId":"model-b"')),
				/repeats a key/,
			],
			["repeated top-level key", () => put("dup2.json", valid.replace("{", '{"members":[],')), /repeats a key/],
			["invalid limit", () => put("limit.json", valid.replace('"timeoutMs":135000', '"timeoutMs":0')), /timeoutMs/],
		];
		for (const [name, make, message] of cases) {
			const path = make();
			expect(() => readCoordinatorModelPoolFileV0(path), name).toThrow(message);
			const cli = await runCli(["coordinator", "pool", "check", "--pool", path, "--quiet"]);
			expect(cli.status, name).toBe(1);
			expect(cli.stderr, name).toMatch(/pool file/);
			expect(cli.stdout, name).toBe("");
		}
		writeFileSync(join(dir, "ok.json"), valid);
		expect(readCoordinatorModelPoolFileV0(join(dir, "ok.json")).members[0]?.endpoint).toBe(server.origin);
		expect(server.connections).toBe(0);
	});

	it("gives actionable CLI diagnostics for explicit-member misuse without contacting anything", async () => {
		const server = await fake((_q, s) => s.end("{}"));
		const dir = scratch();
		const path = join(dir, "pool.json");
		writeFileSync(path, JSON.stringify(doc([local("primary", server.origin)])));
		const store = join(dir, "store");
		const noPool = await runCli(["coordinator", "brief", store, "--project", projectId, "--member", "primary"]);
		expect(noPool.status).toBe(1);
		expect(noPool.stderr).toMatch(/--member selects a member of a pool/);
		const unknown = await runCli([
			"coordinator",
			"brief",
			store,
			"--project",
			projectId,
			"--pool",
			path,
			"--member",
			"ghost",
		]);
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toMatch(/--member ghost is not in the pool; its members are: primary/);
		const malformed = await runCli([
			"coordinator",
			"brief",
			store,
			"--project",
			projectId,
			"--pool",
			path,
			"--member",
			"../x",
		]);
		expect(malformed.status).toBe(1);
		const legacy = await runCli([
			"coordinator",
			"brief",
			store,
			"--project",
			projectId,
			"--pool",
			path,
			"--model-member",
			"primary",
		]);
		expect(legacy.status).toBe(1);
		expect(legacy.stderr).toMatch(/usage: endo coordinator brief/);
		expect(server.connections).toBe(0);
	});
});

describe("M1-AT07 network boundary", () => {
	it.each([
		"http://localhost:8091",
		"http://127.1:8091",
		"http://127.0.1:8091",
		"http://0x7f.0.0.1:8091",
		"http://0177.0.0.1:8091",
		"http://2130706433:8091",
		"http://127.0.0.2:8091",
		"http://0.0.0.0:8091",
		"http://[::1]:8091",
		"http://[::ffff:127.0.0.1]:8091",
		"http://[0:0:0:0:0:0:0:1]:8091",
		"http://127.0.0.1.:8091",
		"http://127.0.0.1:8091/",
		"http://127.0.0.1:8091/v1",
		"http://127.0.0.1:8091?x=1",
		"http://127.0.0.1:8091#x",
		"http://user:pass@127.0.0.1:8091",
		"http://127.0.0.1@192.0.2.1:8091",
		"http://192.0.2.1:8091",
		"http://example.com:8091",
		"https://127.0.0.1:8091",
		"HTTP://127.0.0.1:8091",
		"http://127.0.0.1",
		"http://127.0.0.1:0",
		"http://127.0.0.1:08091",
		"http://127.0.0.1:65536",
		" http://127.0.0.1:8091",
		"http://127.0.0.1:8091\n",
		"http://127.0.0.1:8091\\@192.0.2.1",
	])("refuses %j as a local endpoint", (endpoint) => {
		expect(endoCoordinatorLoopbackOriginV0(endpoint).ok).toBe(false);
		expect(() => poolOf([local("primary", endpoint)])).toThrow(/endpoint/);
	});

	it("never connects to a listener reachable through a refused spelling", async () => {
		const v4 = await fake((_q, s) => s.end("{}"));
		let v6: Fake | null = null;
		try {
			v6 = await fake((_q, s) => s.end("{}"), "::1", v4.port);
		} catch {
			v6 = null;
		}
		const dir = scratch();
		for (const endpoint of [
			`http://localhost:${v4.port}`,
			`http://[::1]:${v4.port}`,
			`http://127.1:${v4.port}`,
			`http://2130706433:${v4.port}`,
			`http://127.0.0.1:${v4.port}/`,
		]) {
			const path = join(dir, "pool.json");
			writeFileSync(path, JSON.stringify(doc([local("primary", endpoint)])));
			const cli = await runCli(["coordinator", "pool", "check", "--pool", path, "--quiet"]);
			expect(cli.status, endpoint).toBe(1);
		}
		expect(v4.connections).toBe(0);
		expect(v6?.connections ?? 0).toBe(0);
	});

	it("does not follow a redirect from a health route; the redirect target is never contacted", async () => {
		const target = await fake(llama({ mode: "single", sleeping: false }).handler);
		const redirector = await fake((_q, s) => {
			s.statusCode = 307;
			s.setHeader("location", `${target.origin}/health`);
			s.end();
		});
		const result = await probeLocalEndpointV0(poolOf([local("primary", redirector.origin)]).members[0]!);
		expect(result).toMatchObject({ readiness: "probe-refused", detail: "redirect" });
		expect(target.connections).toBe(0);
		expect(redirector.hits.map((h) => h.url)).toEqual(["/health"]);
	});

	it("the relay is bound to the selected member's origin and refuses an upstream redirect", async () => {
		const elsewhere = await fake((_q, s) => s.end("{}"));
		const upstream = await fake((_q, s) => {
			s.statusCode = 307;
			s.setHeader("location", `${elsewhere.origin}/v1/chat/completions`);
			s.end();
		});
		const target = coordinatorTargetFromMemberV0(poolOf([local("primary", upstream.origin)]).members[0]!);
		const { wire, response } = await throughRelay(target, [requestBody(target)]);
		expect(response[0]?.status ?? null).not.toBe(200);
		expect(wire.trace.refusal).toBe("model-unavailable");
		expect(elsewhere.connections).toBe(0);
		expect(upstream.hits.map((h) => `${h.method} ${h.url}`)).toEqual(["POST /v1/chat/completions"]);
	});

	it("refuses to build a relay or a target for a non-loopback or hosted member", async () => {
		const hosted = poolOf([local("cloud", "https://openrouter.ai", { kind: "hosted-relay" })]).members[0]!;
		expect(() => coordinatorTargetFromMemberV0(hosted)).toThrow(/hosted|local/);
		await expect(probeLocalEndpointV0(hosted)).rejects.toThrow(/local loopback/);
	});
});

describe("M1-AT08 zero-inference observation and M1-AT09 honest readiness", () => {
	it.each([
		[
			"router, model loaded",
			{ mode: "router" },
			"capacity-unknown",
			"slots-not-probed-router",
			["/health", "/props", "/models"],
		],
		[
			"router, model unloaded",
			{ mode: "router", models: { "model-a": "unloaded" } },
			"model-unconfirmed",
			"model-unloaded",
			["/health", "/props", "/models"],
		],
		[
			"router, model sleeping",
			{ mode: "router", models: { "model-a": "sleeping" } },
			"model-unconfirmed",
			"model-sleeping",
			["/health", "/props", "/models"],
		],
		[
			"router, model loading",
			{ mode: "router", models: { "model-a": "loading" } },
			"loading",
			"model-loading",
			["/health", "/props", "/models"],
		],
		[
			"router, model load failed",
			{ mode: "router", models: { "model-a": "failed" } },
			"model-unavailable",
			"model-failed",
			["/health", "/props", "/models"],
		],
		[
			"router, model downloading",
			{ mode: "router", models: { "model-a": "downloading" } },
			"model-unavailable",
			"model-incomplete",
			["/health", "/props", "/models"],
		],
		[
			"router, model missing",
			{ mode: "router", models: { "model-b": "loaded" } },
			"model-unavailable",
			"model-not-listed",
			["/health", "/props", "/models"],
		],
		[
			"router, substituted name only",
			{ mode: "router", models: { "Model-A": "loaded", "model-a:Q4": "loaded" } },
			"model-unavailable",
			"model-not-listed",
			["/health", "/props", "/models"],
		],
		["server loading", { mode: "router", health: "loading" }, "loading", "server-loading", ["/health"]],
		["server error", { mode: "single", health: 500 }, "unhealthy", "health-error", ["/health"]],
		[
			"single, awake, idle slot",
			{ mode: "single", sleeping: false },
			"ready",
			"slot-idle",
			["/health", "/props", "/models", "/slots?fail_on_no_slot=1"],
		],
		[
			"single, awake, saturated",
			{ mode: "single", sleeping: false, slots: 503 },
			"saturated",
			"no-idle-slot",
			["/health", "/props", "/models", "/slots?fail_on_no_slot=1"],
		],
		[
			"single, slots disabled",
			{ mode: "single", sleeping: false, slots: 501 },
			"capacity-unknown",
			"slots-not-observable",
			["/health", "/props", "/models", "/slots?fail_on_no_slot=1"],
		],
		[
			"single, sleeping",
			{ mode: "single", sleeping: true },
			"model-unconfirmed",
			"model-sleeping",
			["/health", "/props", "/models"],
		],
		[
			"single, sleep state unknown",
			{ mode: "single", sleeping: null },
			"capacity-unknown",
			"slots-not-probed-sleeping-unknown",
			["/health", "/props", "/models"],
		],
		[
			"single, listing missing",
			{ mode: "single", sleeping: false, listing: 404 },
			"model-unconfirmed",
			"model-listing-unavailable",
			["/health", "/props", "/models"],
		],
		[
			"other OpenAI-compatible server",
			{ mode: "openai" },
			"capacity-unknown",
			"slots-not-observable",
			["/health", "/props", "/v1/models"],
		],
	] as const)("%s", async (_name, options, readiness, detail, paths) => {
		const server = llama(options as Parameters<typeof llama>[0]);
		const endpoint = await fake(server.handler);
		const result = await probeLocalEndpointV0(poolOf([local("primary", endpoint.origin)]).members[0]!);
		expect(result).toMatchObject({ readiness, detail, basis: "controller-observed", inferenceTokens: 0 });
		expect(endpoint.hits.map((h) => h.url)).toEqual(paths);
		expect(endpoint.hits.every((h) => h.method === "GET" && h.authorization === undefined)).toBe(true);
		expect(server.state).toEqual({ loads: 0, completions: 0 });
		if (readiness !== "ready") {
			const pool = poolOf([local("primary", endpoint.origin)]);
			const check = await checkCoordinatorModelPoolV0(pool, "file");
			if (check.selection.ok) expect(check.selection.capacityConfirmed).toBe(false);
		}
	});

	it("pool check observes every member, requests no completion, loads nothing and only a slot-observed member confirms capacity", async () => {
		const router = llama({ mode: "router", models: { "model-a": "unloaded", "model-b": "loaded" } });
		const single = llama({ mode: "single", sleeping: false });
		const r = await fake(router.handler);
		const s = await fake(single.handler);
		const dir = scratch();
		const path = join(dir, "pool.json");
		writeFileSync(
			path,
			JSON.stringify(
				doc(
					[
						local("router-cold", r.origin, { priority: 30 }),
						local("router-warm", r.origin, { priority: 20, modelId: "model-b" }),
						local("single", s.origin, { priority: 10 }),
						local("cloud", "https://openrouter.ai", { kind: "hosted-relay", priority: 99 }),
					],
					{ fallback: "availability", unconfirmedModel: "refuse" },
				),
			),
		);
		const cli = await runCli(["coordinator", "pool", "check", "--pool", path]);
		expect(cli.status, cli.stderr).toBe(0);
		const check = JSON.parse(cli.stdout).coordinatorModelPool;
		expect(check.inferenceTokens).toBe(0);
		expect(
			check.members.map((m: { memberId: string; observation: { readiness: string } | null }) => [
				m.memberId,
				m.observation?.readiness ?? null,
			]),
		).toEqual([
			["cloud", null],
			["router-cold", "model-unconfirmed"],
			["router-warm", "capacity-unknown"],
			["single", "ready"],
		]);
		expect(check.selection).toEqual({
			ok: true,
			selectedMemberId: "router-warm",
			capacityConfirmed: false,
			fallbackOccurred: true,
			skippedMembers: [
				{ memberId: "cloud", reason: "hosted-not-permitted" },
				{ memberId: "router-cold", reason: "model-unconfirmed" },
			],
		});
		expect(cli.stderr).toMatch(/zero inference tokens/);
		expect(router.state).toEqual({ loads: 0, completions: 0 });
		expect(single.state).toEqual({ loads: 0, completions: 0 });
		expect([...r.hits, ...s.hits].some((h) => h.method !== "GET" || h.url.includes("completions"))).toBe(false);
	});

	it("pool check without --pool describes M0's endpoint as one member and stays read-only", () => {
		expect(ENDO_COORDINATOR_M0_POOL_V0.members).toEqual([
			expect.objectContaining({
				memberId: "m0-default",
				endpoint: "http://127.0.0.1:8091",
				modelId: "Inkling-2-Mini-Uncensored-AD-Q4_K",
				maxOutputTokens: 2048,
			}),
		]);
		expect(ENDO_COORDINATOR_M0_POOL_V0.selection).toEqual({ fallback: "none", unconfirmedModel: "permit" });
	});
});

describe("M1-AT10 bounded observation", () => {
	it("times out a silent endpoint at the deadline and never accepts its late answer", async () => {
		let late = 0;
		const server = await fake((_q, s) => {
			setTimeout(() => {
				late += 1;
				s.end(JSON.stringify({ status: "ok" }));
			}, 600);
		});
		const started = performance.now();
		const result = await probeLocalEndpointV0(poolOf([local("primary", server.origin)]).members[0]!, {
			deadlineMs: 150,
		});
		expect(performance.now() - started).toBeLessThan(500);
		expect(result).toMatchObject({ readiness: "unreachable", detail: "timeout" });
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(late).toBe(1);
		expect(result.readiness).toBe("unreachable");
	});

	it("reports cancellation, a refused connection, an oversized body or head and an interrupted body without retrying", async () => {
		const silent = await fake(() => {});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		await expect(
			probeLocalEndpointV0(poolOf([local("primary", silent.origin)]).members[0]!, { signal: controller.signal }),
		).resolves.toMatchObject({ readiness: "unreachable", detail: "cancelled" });

		const port = await closedPort();
		await expect(
			probeLocalEndpointV0(poolOf([local("primary", `http://127.0.0.1:${port}`)]).members[0]!),
		).resolves.toMatchObject({
			readiness: "unreachable",
			detail: "connect-failed",
			requests: [{ path: "/health", status: null }],
		});

		const big = await fake((_q, s) => s.end("x".repeat(300 * 1024)));
		await expect(probeLocalEndpointV0(poolOf([local("primary", big.origin)]).members[0]!)).resolves.toMatchObject({
			readiness: "probe-refused",
			detail: "response-too-large",
		});
		expect(big.hits).toHaveLength(1);

		const head = await fake((_q, s) => {
			s.setHeader("x-pad", "y".repeat(16 * 1024));
			s.end("{}");
		});
		await expect(probeLocalEndpointV0(poolOf([local("primary", head.origin)]).members[0]!)).resolves.toMatchObject({
			readiness: "probe-refused",
			detail: "response-too-large",
		});

		const cut = await fake((_q, s) => {
			s.writeHead(200, { "content-length": "100" });
			s.write("{");
			setTimeout(() => s.socket?.destroy(), 20);
		});
		await expect(probeLocalEndpointV0(poolOf([local("primary", cut.origin)]).members[0]!)).resolves.toMatchObject({
			readiness: "unreachable",
			detail: "connect-failed",
		});
		expect(cut.hits).toHaveLength(1);

		const garbage = await fake((_q, s) => {
			s.socket?.end("not http\r\n\r\n");
		});
		await expect(probeLocalEndpointV0(poolOf([local("primary", garbage.origin)]).members[0]!)).resolves.toMatchObject(
			{
				readiness: "unreachable",
			},
		);
	});

	it("refuses malformed listings rather than guessing", async () => {
		const server = await fake((req, res) => {
			if (req.url === "/props") return res.end(JSON.stringify({ role: "router" }));
			if (req.url === "/models")
				return res.end(JSON.stringify({ data: [{ id: "model-a", status: { value: "mystery" } }] }));
			res.end(JSON.stringify({ status: "ok" }));
		});
		await expect(probeLocalEndpointV0(poolOf([local("primary", server.origin)]).members[0]!)).resolves.toMatchObject({
			readiness: "probe-refused",
			detail: "malformed-response",
		});
		const twice = await fake((req, res) => {
			if (req.url === "/props") return res.end(JSON.stringify({ is_sleeping: false }));
			if (req.url === "/models") return res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-a" }] }));
			res.end(JSON.stringify({ status: "ok" }));
		});
		await expect(probeLocalEndpointV0(poolOf([local("primary", twice.origin)]).members[0]!)).resolves.toMatchObject({
			readiness: "probe-refused",
			detail: "malformed-response",
		});
	});
});

describe("M1-AT03 priority selection, M1-AT04 fallback, M1-AT05 outage, M1-AT06 explicit selection", () => {
	const observer =
		(readiness: Record<string, EndoCoordinatorMemberObservationV0["readiness"]>, seen: string[]) =>
		async (member: { memberId: string; endpoint: string }) => {
			seen.push(member.memberId);
			return observation(member.memberId, member.endpoint, readiness[member.memberId] ?? "ready");
		};
	const members = [
		local("low", "http://127.0.0.1:9001", { priority: 10, modelId: "model-a" }),
		local("beta", "http://127.0.0.1:9002", { priority: 50, modelId: "model-a" }),
		local("alpha", "http://127.0.0.1:9003", { priority: 50, modelId: "model-a" }),
	];

	it("selects the highest priority, breaks ties by memberId, ignores file order, and observes lazily", async () => {
		for (const order of [members, [...members].reverse(), [members[1], members[2], members[0]]]) {
			const seen: string[] = [];
			const selection = await selectCoordinatorModelV0(poolOf(order), {}, observer({}, seen));
			expect(selection).toMatchObject({ ok: true, mode: "priority", fallbackOccurred: false, skippedMembers: [] });
			if (selection.ok) expect(selection.member.memberId).toBe("alpha");
			expect(seen).toEqual(["alpha"]);
		}
	});

	it.each(["saturated", "unreachable", "unhealthy", "loading", "model-unavailable", "probe-refused"] as const)(
		"falls back past a %s primary with exact provenance",
		async (state) => {
			const seen: string[] = [];
			const selection = await selectCoordinatorModelV0(poolOf(members), {}, observer({ alpha: state }, seen));
			expect(selection).toMatchObject({
				ok: true,
				fallbackOccurred: true,
				skippedMembers: [{ memberId: "alpha", reason: state }],
			});
			if (selection.ok) expect(selection.member.memberId).toBe("beta");
			expect(seen).toEqual(["alpha", "beta"]);
		},
	);

	it("honours fallback none and the unconfirmed-model policy", async () => {
		const seen: string[] = [];
		const none = await selectCoordinatorModelV0(
			poolOf(members, { fallback: "none", unconfirmedModel: "refuse" }),
			{},
			observer({ alpha: "saturated" }, seen),
		);
		expect(none).toMatchObject({
			ok: false,
			refusal: "no-healthy-member",
			skippedMembers: [{ memberId: "alpha", reason: "saturated" }],
		});
		expect(seen).toEqual(["alpha"]);
		const refuse = await selectCoordinatorModelV0(poolOf(members), {}, observer({ alpha: "model-unconfirmed" }, []));
		expect(refuse.ok && refuse.member.memberId).toBe("beta");
		const permit = await selectCoordinatorModelV0(
			poolOf(members, { fallback: "availability", unconfirmedModel: "permit" }),
			{},
			observer({ alpha: "model-unconfirmed" }, []),
		);
		expect(permit.ok && permit.member.memberId).toBe("alpha");
	});

	it("end to end: a saturated primary hands the briefing to the secondary, which alone receives the target", async () => {
		const primaryServer = llama({ mode: "single", sleeping: false, slots: 503 });
		const secondaryServer = llama({ mode: "router", models: { "model-b": "loaded" } });
		const primary = await fake(primaryServer.handler);
		const secondary = await fake(secondaryServer.handler);
		const pool = poolOf([
			local("primary", primary.origin, { priority: 20 }),
			local("secondary", secondary.origin, {
				priority: 10,
				modelId: "model-b",
				maxOutputTokens: 1024,
				timeoutMs: 60_000,
				maxPromptBytes: 4096,
			}),
		]);
		const { run, calls } = fakeRun();
		const result = await briefFromCoordinatorSubstrateV0(
			{ projectId },
			pooledCoordinatorV0("/nonexistent", pool, { run }),
		);
		expect(calls).toEqual([
			{
				target: {
					origin: secondary.origin,
					model: "model-b",
					maxOutputTokens: 1024,
					maxPromptBytes: 4096,
					timeoutMs: 60_000,
					pinResponseModel: true,
				},
				provider: "llama.cpp b12622-19bc41dbb",
			},
		]);
		expect(Object.isFrozen(calls[0]?.target)).toBe(true);
		expect(result).toMatchObject({
			availability: "available",
			runtime: { model: "model-b" },
			modelPool: {
				schemaVersion: "endo.coordinator-model-pool-provenance.v0",
				selectionMode: "priority",
				requestedMemberId: null,
				selectedMemberId: "secondary",
				selectedModelId: "model-b",
				selectedEndpoint: secondary.origin,
				selectedReadiness: "capacity-unknown",
				capacityConfirmed: false,
				fallbackOccurred: true,
				skippedMembers: [{ memberId: "primary", reason: "saturated" }],
				inferenceFailover: "never",
				measurements: {
					inferenceElapsedMs: 12,
					promptTokens: 400,
					completionTokens: 50,
					exchanges: 2,
					failureCategory: null,
				},
			},
		});
		expect(primaryServer.state).toEqual({ loads: 0, completions: 0 });
		expect(secondaryServer.state).toEqual({ loads: 0, completions: 0 });
	});

	it("total outage: a typed unavailable result with no answer, no evidence and no inference", async () => {
		const pool = poolOf([
			local("one", `http://127.0.0.1:${await closedPort()}`, { priority: 2 }),
			local("two", `http://127.0.0.1:${await closedPort()}`, { priority: 1 }),
		]);
		const { run, calls } = fakeRun();
		const result = await briefFromCoordinatorSubstrateV0(
			{ projectId },
			pooledCoordinatorV0("/nonexistent", pool, { run }),
		);
		expect(calls).toEqual([]);
		expect(result).toEqual({
			schemaVersion: "endo.coordinator-brief.v0",
			projectId,
			runtime: { harness: "OpenClaw 2026.11.7", provider: "none", model: "none" },
			availability: "unavailable",
			reason: "no-healthy-member",
			modelPool: expect.objectContaining({
				selectedMemberId: null,
				selectedModelId: null,
				fallbackOccurred: false,
				skippedMembers: [
					{ memberId: "one", reason: "unreachable" },
					{ memberId: "two", reason: "unreachable" },
				],
				measurements: expect.objectContaining({
					inferenceElapsedMs: null,
					promptTokens: null,
					failureCategory: "no-healthy-member",
				}),
			}),
		});
		expect(result).not.toHaveProperty("answer");
		expect(result).not.toHaveProperty("evidence");
	});

	it("an explicit member that is unavailable is refused, never switched; the other member is never contacted", async () => {
		const saturated = llama({ mode: "single", sleeping: false, slots: 503 });
		const healthy = llama({ mode: "single", sleeping: false });
		const a = await fake(saturated.handler);
		const b = await fake(healthy.handler);
		const pool = poolOf([local("chosen", a.origin, { priority: 1 }), local("better", b.origin, { priority: 99 })]);
		const { run, calls } = fakeRun();
		const result = await briefFromCoordinatorSubstrateV0(
			{ projectId },
			pooledCoordinatorV0("/nonexistent", pool, { run, memberId: "chosen" }),
		);
		expect(result).toMatchObject({
			availability: "unavailable",
			reason: "member-unavailable",
			modelPool: {
				selectionMode: "explicit",
				requestedMemberId: "chosen",
				selectedMemberId: null,
				fallbackOccurred: false,
				skippedMembers: [{ memberId: "chosen", reason: "saturated" }],
			},
		});
		expect(calls).toEqual([]);
		expect(b.connections).toBe(0);
		const missing = await pooledCoordinatorV0("/nonexistent", pool, { run, memberId: "ghost" }).brief({ projectId });
		expect(missing).toMatchObject({ availability: "unavailable", reason: "member-not-found" });
		const explicitOk = await pooledCoordinatorV0("/nonexistent", pool, { run, memberId: "better" }).brief({
			projectId,
		});
		expect(explicitOk).toMatchObject({
			availability: "available",
			modelPool: {
				selectionMode: "explicit",
				selectedMemberId: "better",
				fallbackOccurred: false,
				capacityConfirmed: true,
			},
		});
		expect(a.connections).toBe(1 * 4);
	});
});

describe("M1-AT11 model identity", () => {
	it("refuses a response that names another model, on the pooled wire only", () => {
		const target = coordinatorTargetFromMemberV0(poolOf([local("primary", "http://127.0.0.1:9001")]).members[0]!);
		const gate = coordinatorWireV0(projectId, toolText, key, undefined, {
			inference: coordinatorInferenceForV0(target),
			model: target.model,
		});
		expect(gate.request({ headers, body: payload(target) })).toBe(true);
		expect(gate.response(response(sse(call(ENDO_COORDINATOR_TOOL_V0), "tool_calls", "substitute-model")))).toBe(
			false,
		);
		expect(gate.trace.refusal).toBe("model-identity-mismatch");
		const same = coordinatorWireV0(projectId, toolText, key, undefined, {
			inference: coordinatorInferenceForV0(target),
			model: target.model,
		});
		expect(same.request({ headers, body: payload(target) })).toBe(true);
		expect(same.response(response(sse(call(ENDO_COORDINATOR_TOOL_V0), "tool_calls", "model-a")))).toBe(true);
	});

	it("refuses a request for another model at the relay policy", () => {
		const target = coordinatorTargetFromMemberV0(poolOf([local("primary", "http://127.0.0.1:9001")]).members[0]!);
		expect(coordinatorRelayPolicyV0(target).model).toBe("model-a");
	});

	it("a runner reporting another model cannot acquire the member's provenance", async () => {
		const server = await fake(llama({ mode: "single", sleeping: false }).handler);
		const pool = poolOf([local("primary", server.origin)]);
		const { run } = fakeRun(() => ({
			runtime: { harness: "OpenClaw 2026.11.7", provider: "x", model: "substitute" },
		}));
		const result = await briefFromCoordinatorSubstrateV0(
			{ projectId },
			pooledCoordinatorV0("/nonexistent", pool, { run }),
		);
		expect(result).toMatchObject({ availability: "unavailable", reason: "model-identity-mismatch" });
		expect(result).not.toHaveProperty("answer");
	});

	it("the contract refuses an available pooled result whose runtime model differs from its provenance", async () => {
		const offered = {
			schemaVersion: "endo.coordinator-brief.v0",
			projectId,
			runtime: { harness: "h", provider: "p", model: "substitute" },
			availability: "available",
			answer: "x",
			evidence: { readAtMs: 1, projectionSha256: "a".repeat(64), modelViewSha256: "b".repeat(64) },
			toolSurface: [ENDO_COORDINATOR_TOOL_V0],
			modelPool: { selectedMemberId: "primary", selectedModelId: "model-a" },
		} as unknown as EndoCoordinatorBriefResultV0;
		await expect(
			briefFromCoordinatorSubstrateV0({ projectId }, { brief: async () => offered }),
		).resolves.toMatchObject({
			availability: "unavailable",
			reason: "model-identity-mismatch",
		});
	});
});

const toolText = '{"availability":"available","status":{}}';
const tool = { type: "function", function: ENDO_COORDINATOR_TOOL_DEFINITION_V0 };
const key = "fixture";
const headers: readonly [string, string][] = [["authorization", `Bearer ${key}`]];
const payload = (
	target: EndoCoordinatorModelTargetV0,
	tools: unknown[] = [tool],
	messages: unknown[] = [],
	extra = {},
) =>
	Buffer.from(
		JSON.stringify({
			model: target.model,
			tools,
			messages,
			stream: true,
			...coordinatorInferenceForV0(target),
			...extra,
		}),
	);
const call = (name: string, args = "{}", id = "call_0") => ({
	tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }],
});
function sse(delta: unknown, finish: string, model = "model-a") {
	return `${[
		{ choices: [{ index: 0, delta, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: finish }] },
		{ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
	]
		.map((v) => `data: ${JSON.stringify({ id: "chat", object: "chat.completion.chunk", model, ...v })}\n\n`)
		.join("")}data: [DONE]\n\n`;
}
const response = (stream: string) => ({
	status: 200,
	wire: Buffer.from(
		`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(stream)}\r\n\r\n${stream}`,
	),
});

describe("M1-AT12 tool surface integrity for a pool member", () => {
	const target = () =>
		coordinatorTargetFromMemberV0(
			poolOf([local("primary", "http://127.0.0.1:9001", { maxOutputTokens: 1024 })]).members[0]!,
		);
	const gate = () => {
		const t = target();
		return {
			t,
			g: coordinatorWireV0(projectId, toolText, key, undefined, {
				inference: coordinatorInferenceForV0(t),
				model: t.model,
			}),
		};
	};

	it("refuses an expanded tool list, a foreign inference setting and a generation bound above the member's", () => {
		const a = gate();
		expect(
			a.g.request({ headers, body: payload(a.t, [tool, { type: "function", function: { name: "exec" } }]) }),
		).toBe(false);
		expect(a.g.trace.refusal).toBe("tool-surface-mismatch");
		const b = gate();
		expect(b.g.request({ headers, body: payload(b.t, [tool], [], { max_tokens: 2048 }) })).toBe(false);
		expect(b.g.trace.refusal).toBe("model-unavailable");
		const c = gate();
		expect(c.g.request({ headers, body: payload(c.t, [tool], [], { ...COORDINATOR_INFERENCE_V0 }) })).toBe(false);
		expect(coordinatorRelayPolicyV0(target()).maxCompletionTokens).toBe(1024);
	});

	it.each([
		["exec", "{}", "tool-not-permitted"],
		[ENDO_COORDINATOR_TOOL_V0, JSON.stringify({ project: other }), "project-out-of-scope"],
		[ENDO_COORDINATOR_TOOL_V0, '{"project":"../../etc"}', "malformed-selector"],
		[ENDO_COORDINATOR_TOOL_V0, `{"project":"${projectId}","path":"/"}`, "malformed-selector"],
	] as const)("refuses a generated %s call with %s", (name, args, reason) => {
		const { t, g } = gate();
		expect(g.request({ headers, body: payload(t) })).toBe(true);
		expect(g.response(response(sse(call(name, args), "tool_calls")))).toBe(false);
		expect(g.trace.refusal).toBe(reason);
	});

	it.each([
		["a fabricated result", "invented", "call_0"],
		["a result for another call id", toolText, "call_9"],
	])("refuses %s in the follow-up request", (_name, content, id) => {
		const { t, g } = gate();
		expect(g.request({ headers, body: payload(t) })).toBe(true);
		expect(g.response(response(sse(call(ENDO_COORDINATOR_TOOL_V0), "tool_calls")))).toBe(true);
		expect(g.request({ headers, body: payload(t, [tool], [{ role: "tool", tool_call_id: id, content }]) })).toBe(
			false,
		);
		expect(g.trace.refusal).toBe("ungrounded");
		expect(g.trace.statusDelivered).toBe(false);
	});
});

describe("M1-AT13 reasoning-only and truncated completions", () => {
	it("records no answer text for a reasoning-only completion and keeps a truncated finish visible", () => {
		const t = coordinatorTargetFromMemberV0(poolOf([local("primary", "http://127.0.0.1:9001")]).members[0]!);
		const g = coordinatorWireV0(projectId, toolText, key, undefined, {
			inference: coordinatorInferenceForV0(t),
			model: t.model,
		});
		expect(g.request({ headers, body: payload(t) })).toBe(true);
		expect(g.response(response(sse(call(ENDO_COORDINATOR_TOOL_V0), "tool_calls")))).toBe(true);
		expect(
			g.request({
				headers,
				body: payload(t, [tool], [{ role: "tool", tool_call_id: "call_0", content: toolText }]),
			}),
		).toBe(true);
		expect(g.response(response(sse({ reasoning_content: "Thinking about the status." }, "stop")))).toBe(true);
		expect(g.trace.responses.at(-1)).toMatchObject({ finish: "stop", text: "" });
		const h = coordinatorWireV0(projectId, toolText, key, undefined, {
			inference: coordinatorInferenceForV0(t),
			model: t.model,
		});
		expect(h.request({ headers, body: payload(t) })).toBe(true);
		expect(h.response(response(sse({ content: "partial" }, "length")))).toBe(true);
		expect(h.trace.responses.at(-1)).toMatchObject({ finish: "length", toolCalled: false });
	});
});

describe("M1-AT14 refusal integrity: no failover after inference is dispatched", () => {
	it.each([
		"tool-expansion-suggested",
		"model-unavailable",
		"generation-limit",
		"ungrounded",
		"tool-not-permitted",
	] as const)("a %s result from the selected member is final; the next member is never contacted", async (reason) => {
		const first = await fake(llama({ mode: "single", sleeping: false }).handler);
		const secondServer = llama({ mode: "single", sleeping: false });
		const second = await fake(secondServer.handler);
		const pool = poolOf([
			local("first", first.origin, { priority: 2 }),
			local("second", second.origin, { priority: 1 }),
		]);
		const { run, calls } = fakeRun(
			() => ({ availability: "unavailable", reason }) as Partial<EndoCoordinatorBriefResultV0>,
		);
		const result = await briefFromCoordinatorSubstrateV0(
			{ projectId },
			pooledCoordinatorV0("/nonexistent", pool, { run }),
		);
		expect(result).toMatchObject({
			availability: "unavailable",
			reason,
			modelPool: {
				selectedMemberId: "first",
				inferenceFailover: "never",
				measurements: { failureCategory: reason },
			},
		});
		expect(calls.map((c) => c.target.origin)).toEqual([first.origin]);
		expect(second.connections).toBe(0);
	});
});

describe("M1-AT15 state preservation", () => {
	it("observation, selection, refusal and a successful pooled briefing leave the store and project unchanged", async () => {
		const dir = scratch();
		const f = createBriefFixtureV0(dir, "review");
		const before = fixtureManifestV0(dir);
		const ok = await fake(llama({ mode: "single", sleeping: false }).handler);
		const pool = poolOf([
			local("ok", ok.origin, { priority: 2 }),
			local("down", `http://127.0.0.1:${await closedPort()}`, { priority: 3 }),
		]);
		await checkCoordinatorModelPoolV0(pool, "file");
		const { run } = fakeRun();
		await pooledCoordinatorV0(f.root, pool, { run }).brief({ projectId: f.projectId });
		await pooledCoordinatorV0(f.root, pool, { run, memberId: "down" }).brief({ projectId: f.projectId });
		const poolFile = join(scratch(), "pool.json");
		writeFileSync(poolFile, JSON.stringify(doc([local("ok", ok.origin)])));
		expect((await runCli(["coordinator", "pool", "check", "--pool", poolFile, "--quiet"])).status).toBe(0);
		expect(fixtureManifestV0(dir)).toBe(before);
	});
});

describe("M1-AT16 hosted execution exclusion", () => {
	it("a hosted member is parsed but never observed, selected or contacted, even when it points at a listener", async () => {
		const trap = await fake((_q, s) => s.end("{}"));
		const local1 = await fake(llama({ mode: "single", sleeping: false }).handler);
		const pool = poolOf([
			local("cloud", `https://127.0.0.1:${trap.port}`, { kind: "hosted-relay", priority: 100 }),
			local("cloud-2", "https://openrouter.ai", { kind: "hosted-relay", priority: 90 }),
			local("home", local1.origin, { priority: 1 }),
		]);
		const seen: string[] = [];
		const selection = await selectCoordinatorModelV0(pool, {}, async (m) => {
			seen.push(m.memberId);
			return probeLocalEndpointV0(m);
		});
		expect(seen).toEqual(["home"]);
		expect(selection).toMatchObject({
			ok: true,
			skippedMembers: [
				{ memberId: "cloud", reason: "hosted-not-permitted" },
				{ memberId: "cloud-2", reason: "hosted-not-permitted" },
			],
		});
		const { run, calls } = fakeRun();
		const explicit = await pooledCoordinatorV0("/nonexistent", pool, { run, memberId: "cloud" }).brief({ projectId });
		expect(explicit).toMatchObject({ availability: "unavailable", reason: "member-not-permitted" });
		const onlyHosted = poolOf([local("cloud", `https://127.0.0.1:${trap.port}`, { kind: "hosted-relay" })]);
		await expect(checkCoordinatorModelPoolV0(onlyHosted, "file")).resolves.toMatchObject({
			members: [{ memberId: "cloud", observation: null, reason: "hosted-not-permitted" }],
			selection: { ok: false, refusal: "no-healthy-member" },
		});
		await expect(
			pooledCoordinatorV0("/nonexistent", onlyHosted, { run }).brief({ projectId }),
		).resolves.toMatchObject({
			availability: "unavailable",
			reason: "no-healthy-member",
		});
		expect(calls).toEqual([]);
		expect(trap.connections).toBe(0);
	});
});

describe("M1-AT01 backward compatibility of the M0 binding", () => {
	it("keeps M0's target, inference settings and relay policy digest", () => {
		expect(ENDO_COORDINATOR_M0_TARGET_V0).toEqual({
			origin: "http://127.0.0.1:8091",
			model: "Inkling-2-Mini-Uncensored-AD-Q4_K",
			maxOutputTokens: 2048,
			maxPromptBytes: 8192,
			timeoutMs: 135_000,
			pinResponseModel: false,
		});
		expect(coordinatorInferenceForV0(ENDO_COORDINATOR_M0_TARGET_V0)).toEqual(COORDINATOR_INFERENCE_V0);
		const m0Policy = {
			routes: [{ method: "POST", path: "/v1/chat/completions" }],
			model: "Inkling-2-Mini-Uncensored-AD-Q4_K",
			maxRequestBytes: 512 * 1024,
			maxTransferredBytes: 8 * 1024 * 1024,
			maxConnections: 4,
			maxTotalConnections: 8,
			maxExchanges: 2,
			maxCompletionTokens: 2048,
		};
		expect(coordinatorRelayPolicyV0(ENDO_COORDINATOR_M0_TARGET_V0)).toEqual(m0Policy);
		expect(modelRelayPolicyDigestV0(coordinatorRelayPolicyV0(ENDO_COORDINATOR_M0_TARGET_V0))).toBe(
			modelRelayPolicyDigestV0(m0Policy),
		);
	});

	it("the M0 wire still admits a response naming any model (no new pinning without a pool)", () => {
		const g = coordinatorWireV0(projectId, toolText, key);
		expect(g.request({ headers, body: payload(ENDO_COORDINATOR_M0_TARGET_V0) })).toBe(true);
		expect(g.response(response(sse(call(ENDO_COORDINATOR_TOOL_V0), "tool_calls", "whatever-the-server-says")))).toBe(
			true,
		);
	});

	it("brief without --pool keeps M0's usage and refuses --member alone", async () => {
		const r = await runCli(["coordinator", "brief", "--project", "bad"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/--project needs one endo.project/);
	});
});

/** Drive the real Coordinator relay (generic relay + wire gates) for a target with a plain HTTP client over its Unix socket. */
async function throughRelay(target: EndoCoordinatorModelTargetV0, bodies: Buffer[]) {
	const dir = mkdtempSync(join("/tmp", "epr-"));
	dirs.push(dir);
	const bearer = randomBytes(12).toString("hex");
	const log = new EndoCaptureLogV0(dir, endoDigestKeyV0(randomBytes(32), "coordinator"), "coordinator");
	const { relay, wire } = await startCoordinatorModelRelayV0({
		target,
		projectId,
		toolText,
		bearer,
		runtimeDirectory: dir,
		log,
	});
	const responses: { status: number | null; body: string; error: string | null }[] = [];
	try {
		for (const body of bodies) {
			responses.push(
				await new Promise((resolve) => {
					const req = httpRequest(
						{
							socketPath: relay.socketPath,
							path: "/v1/chat/completions",
							method: "POST",
							agent: false,
							headers: {
								host: "127.0.0.1",
								authorization: `Bearer ${bearer}`,
								"content-type": "application/json",
								"content-length": body.length,
							},
						},
						(res) => {
							const parts: Buffer[] = [];
							res.on("data", (c: Buffer) => parts.push(c));
							res.on("end", () =>
								resolve({ status: res.statusCode ?? null, body: Buffer.concat(parts).toString(), error: null }),
							);
							res.on("error", (e) => resolve({ status: res.statusCode ?? null, body: "", error: e.message }));
						},
					);
					req.on("error", (e) => resolve({ status: null, body: "", error: e.message }));
					req.setTimeout(10_000, () => req.destroy(new Error("client timeout")));
					req.end(body);
				}),
			);
		}
	} finally {
		await relay.close();
		log.close();
	}
	return { wire, relay, response: responses };
}
const requestBody = (target: EndoCoordinatorModelTargetV0) => payloadFor(target);
const payloadFor = (target: EndoCoordinatorModelTargetV0) =>
	Buffer.from(
		JSON.stringify({
			model: target.model,
			tools: [tool],
			messages: [],
			stream: true,
			...coordinatorInferenceForV0(target),
		}),
	);

describe("M1-AT10 bounded execution through the real relay", () => {
	const targetFor = (origin: string) => coordinatorTargetFromMemberV0(poolOf([local("primary", origin)]).members[0]!);

	it("delivers a valid member response and records it", async () => {
		const upstream = await fake((_q, s) => {
			s.setHeader("content-type", "text/event-stream");
			s.end(sse(call(ENDO_COORDINATOR_TOOL_V0), "tool_calls"));
		});
		const { wire, response: r } = await throughRelay(targetFor(upstream.origin), [
			requestBody(targetFor(upstream.origin)),
		]);
		expect(r[0]?.status).toBe(200);
		expect(wire.trace.refusal).toBeNull();
		expect(wire.trace.responses).toHaveLength(1);
	});

	it("an interrupted stream yields no completed response", async () => {
		const upstream = await fake((_q, s) => {
			s.writeHead(200, { "content-type": "text/event-stream", "content-length": "100000" });
			s.write(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }], model: "model-a" })}\n\n`,
			);
			setTimeout(() => s.socket?.destroy(), 30);
		});
		const t = targetFor(upstream.origin);
		const { wire, response: r } = await throughRelay(t, [requestBody(t)]);
		expect(r[0]?.status === 200 && r[0].error === null && r[0].body.includes("[DONE]")).toBe(false);
		expect(wire.trace.responses.filter((x) => x.finish === "stop")).toEqual([]);
	});

	it("an oversized response is cut at the relay's transfer bound", async () => {
		const upstream = await fake((_q, s) => {
			s.setHeader("content-type", "text/event-stream");
			s.end(`:${"x".repeat(9 * 1024 * 1024)}\n\n${sse({ content: "late" }, "stop")}`);
		});
		const t = targetFor(upstream.origin);
		const { wire, relay, response: r } = await throughRelay(t, [requestBody(t)]);
		expect(r[0]?.body.includes("late") ?? false).toBe(false);
		expect(wire.trace.responses.filter((x) => x.finish === "stop")).toEqual([]);
		expect(relay.transferredBytes()).toBeLessThanOrEqual(8 * 1024 * 1024 + 64 * 1024);
	});

	it("a response for a substituted model never reaches the agent", async () => {
		const upstream = await fake((_q, s) => {
			s.setHeader("content-type", "text/event-stream");
			s.end(sse({ content: "answer" }, "stop", "substitute"));
		});
		const t = targetFor(upstream.origin);
		const { wire, response: r } = await throughRelay(t, [requestBody(t)]);
		expect(wire.trace.refusal).toBe("model-identity-mismatch");
		expect(r[0]?.body.includes("answer") ?? false).toBe(false);
	});

	it("a request naming another model or exceeding the member's generation bound never reaches the upstream", async () => {
		const upstream = await fake((_q, s) => s.end("{}"));
		const t = targetFor(upstream.origin);
		const foreign = Buffer.from(JSON.stringify({ ...JSON.parse(requestBody(t).toString()), model: "other" }));
		const greedy = Buffer.from(JSON.stringify({ ...JSON.parse(requestBody(t).toString()), n_predict: -1 }));
		await throughRelay(t, [foreign]);
		await throughRelay(t, [greedy]);
		expect(upstream.connections).toBe(0);
	});
});

const sandboxAvailable = (() => {
	try {
		return (
			process.platform === "linux" &&
			spawnSync("/usr/bin/bwrap", coordinatorBwrapV0([], ["-e", ""]), { env: COORDINATOR_ENV_V0 }).status === 0
		);
	} catch {
		return false;
	}
})();
const openclaw = process.env.ENDO_COORDINATOR_OPENCLAW;

describe.skipIf(!sandboxAvailable || !openclaw)(
	"installed OpenClaw through the pooled path (opt-in, deterministic provider)",
	() => {
		type Scenario = "valid" | "reasoning-only" | "truncated" | "substituted" | "hang" | "slow-stream";
		async function provider(scenario: Scenario, modelId: string) {
			const state = { completions: 0, loads: 0 };
			const probe = llama({ mode: "router", models: { [modelId]: "loaded" }, state });
			const server = await fake((req, res, body) => {
				if (req.method !== "POST") return probe.handler(req, res);
				state.completions += 1;
				const first = !body.includes('"role":"tool"');
				if (scenario === "hang") return;
				res.setHeader("content-type", "text/event-stream");
				if (first) return res.end(sse(call(ENDO_COORDINATOR_TOOL_V0), "tool_calls", modelId));
				if (scenario === "slow-stream") {
					res.write(
						`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Partial" }, finish_reason: null }], model: modelId })}\n\n`,
					);
					return;
				}
				const delta =
					scenario === "reasoning-only"
						? { reasoning_content: "The operator put one task in review." }
						: { content: "The operator put one task in review. This does not establish correctness." };
				res.end(
					sse(
						delta,
						scenario === "truncated" ? "length" : "stop",
						scenario === "substituted" ? "substitute" : modelId,
					),
				);
			});
			return { server, state };
		}

		it.each([
			["valid", null, 2],
			// OpenClaw itself exits non-zero on an empty final answer, before the relay's own ungrounded check is reached.
			["reasoning-only", "runtime-unavailable", 2],
			["truncated", "generation-limit", 2],
			["substituted", "model-identity-mismatch", 2],
		] as const)(
			"%s: falls back from a saturated primary and ends %s",
			async (scenario, reason, completions) => {
				vi.stubEnv("XDG_RUNTIME_DIR", scratch());
				const dir = scratch();
				mkdirSync(join(dir, "control"));
				const f = createBriefFixtureV0(dir, "review");
				const primaryServer = llama({ mode: "single", sleeping: false, slots: 503 });
				const primary = await fake(primaryServer.handler);
				const secondary = await provider(scenario, "model-b");
				const pool = poolOf([
					local("primary", primary.origin, { priority: 2 }),
					local("secondary", secondary.server.origin, { priority: 1, modelId: "model-b", timeoutMs: 60_000 }),
				]);
				const result = await briefFromCoordinatorSubstrateV0(
					{ projectId: f.projectId },
					pooledCoordinatorV0(f.root, pool, {
						run: (root, request, options) => runOpenClawCoordinatorV0(root, request, { ...options, openclaw }),
					}),
				);
				expect(secondary.state).toEqual({ completions, loads: 0 });
				expect(primaryServer.state).toEqual({ loads: 0, completions: 0 });
				expect(result.modelPool).toMatchObject({
					selectedMemberId: "secondary",
					selectedModelId: "model-b",
					fallbackOccurred: true,
					skippedMembers: [{ memberId: "primary", reason: "saturated" }],
				});
				if (reason === null) {
					expect(result).toMatchObject({ availability: "available", runtime: { model: "model-b" } });
					expect(result.modelPool?.measurements).toMatchObject({
						exchanges: 2,
						promptTokens: 10,
						completionTokens: 6,
					});
				} else expect(result).toMatchObject({ availability: "unavailable", reason });
			},
			165_000,
		);

		it.each([
			["hang", "timeout"],
			["slow-stream", "cancellation"],
		] as const)(
			"%s: a %s ends the briefing unavailable within its bound, with no retry and no late answer",
			async (scenario, kind) => {
				vi.stubEnv("XDG_RUNTIME_DIR", scratch());
				const dir = scratch();
				mkdirSync(join(dir, "control"));
				const f = createBriefFixtureV0(dir, "review");
				const p = await provider(scenario, "model-a");
				const pool = poolOf([local("only", p.server.origin, { timeoutMs: 5000 })]);
				const controller = new AbortController();
				if (kind === "cancellation") setTimeout(() => controller.abort(), 8000);
				const started = performance.now();
				const result = await pooledCoordinatorV0(f.root, pool, {
					signal: controller.signal,
					run: (root, request, options) => runOpenClawCoordinatorV0(root, request, { ...options, openclaw }),
				}).brief({ projectId: f.projectId });
				expect(performance.now() - started).toBeLessThan(40_000);
				expect(result.availability).toBe("unavailable");
				expect(result).not.toHaveProperty("answer");
				const completions = p.state.completions;
				await new Promise((resolve) => setTimeout(resolve, 1000));
				expect(p.state.completions).toBe(completions);
				expect(completions).toBeLessThanOrEqual(2);
			},
			165_000,
		);
	},
);
