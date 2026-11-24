import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createUnixServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OpenClawCoordinatorTrialV0, runOpenClawCoordinatorV0 } from "../adapters/coordinator/openclaw.ts";
import {
	COORDINATOR_ENV_V0,
	coordinatorAnswerRefusalV0,
	coordinatorBwrapV0,
	projectStatusCommandV0,
	readCoordinatorBriefStatusV0,
} from "../adapters/coordinator/status.ts";
import { COORDINATOR_INFERENCE_V0, coordinatorWireV0 } from "../adapters/coordinator/wire.ts";
import {
	briefFromCoordinatorSubstrateV0,
	coordinatorToolRefusalV0,
	ENDO_COORDINATOR_TOOL_DEFINITION_V0,
	ENDO_COORDINATOR_TOOL_V0,
	type EndoCoordinatorBriefResultV0,
} from "../runtime/contracts/coordinator-brief.ts";
import { BRIEF_FIXTURES, createBriefFixtureV0, fixtureManifestV0 } from "./coordinator-brief-fixtures.ts";

const projectId = `endo.project.${"a".repeat(32)}`;
const other = `endo.project.${"b".repeat(32)}`;
const toolText = '{"availability":"available","status":{}}';
const tool = { type: "function", function: ENDO_COORDINATOR_TOOL_DEFINITION_V0 };
const key = "fixture";
const headers: readonly [string, string][] = [["authorization", `Bearer ${key}`]];

const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "endo-coord-brief-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const payload = (tools: unknown[] = [tool], messages: unknown[] = []) =>
	Buffer.from(JSON.stringify({ tools, messages, stream: true, ...COORDINATOR_INFERENCE_V0 }));

function sse(delta: unknown, finish: string) {
	const data = [
		{ choices: [{ index: 0, delta, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: finish }] },
		{ choices: [], usage: { prompt_tokens: 56, completion_tokens: 22, total_tokens: 78 } },
	]
		.map(
			(v) =>
				`data: ${JSON.stringify({ id: "chat-fixture", object: "chat.completion.chunk", model: "Inkling-2-Mini-Uncensored-AD-Q4_K", ...v })}\n\n`,
		)
		.join("");
	return `${data}data: [DONE]\n\n`;
}

const call = (name: string, args = "{}") => ({
	tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name, arguments: args } }],
});
const response = (stream: string) => ({
	status: 200,
	wire: Buffer.from(
		`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(stream)}\r\n\r\n${stream}`,
	),
});

describe("Coordinator admission and dispatch", () => {
	it.each([
		[{ toolSurface: [ENDO_COORDINATOR_TOOL_V0, "exec"] }, "tool-surface-mismatch"],
		[{ evidence: undefined }, "ungrounded"],
		[{ evidence: { readAtMs: 1, projectionSha256: "", modelViewSha256: "a".repeat(64) } }, "ungrounded"],
	])("refuses a replacement substrate result with a changed contract: %o", async (override, reason) => {
		const offered = {
			schemaVersion: "endo.coordinator-brief.v0",
			projectId,
			runtime: { harness: "fixture", provider: "fixture", model: "fixture" },
			availability: "available",
			answer: "fixture",
			evidence: { readAtMs: 1, projectionSha256: "b".repeat(64), modelViewSha256: "a".repeat(64) },
			toolSurface: [ENDO_COORDINATOR_TOOL_V0],
			...override,
		} as EndoCoordinatorBriefResultV0;
		await expect(
			briefFromCoordinatorSubstrateV0({ projectId }, { brief: async () => offered }),
		).resolves.toMatchObject({ availability: "unavailable", reason });
	});
	it.each([
		["exec", {}, "tool-not-permitted"],
		[ENDO_COORDINATOR_TOOL_V0, { project: "/etc/passwd" }, "malformed-selector"],
		[ENDO_COORDINATOR_TOOL_V0, { project: "" }, "malformed-selector"],
		[ENDO_COORDINATOR_TOOL_V0, { project: other }, "project-out-of-scope"],
		[ENDO_COORDINATOR_TOOL_V0, { project: projectId, path: "/tmp/fake" }, "malformed-selector"],
		[ENDO_COORDINATOR_TOOL_V0, { project: projectId }, null],
		[ENDO_COORDINATOR_TOOL_V0, {}, null],
	])("validates %s %o before dispatch", (name, params, reason) => {
		expect(coordinatorToolRefusalV0(projectId, name, params)).toBe(reason);
	});

	it("refuses an expanded wire tool surface before contacting the provider", () => {
		const gate = coordinatorWireV0(projectId, toolText, key);
		expect(gate.request({ headers, body: payload([tool, { type: "function", function: { name: "read" } }]) })).toBe(
			false,
		);
		expect(gate.trace.refusal).toBe("tool-surface-mismatch");
	});

	it.each([
		["exec", "{}", "tool-not-permitted"],
		[ENDO_COORDINATOR_TOOL_V0, '{"path":"/tmp/fake"}', "malformed-selector"],
		[ENDO_COORDINATOR_TOOL_V0, '{"project":null}', "malformed-selector"],
		[ENDO_COORDINATOR_TOOL_V0, JSON.stringify({ project: other }), "project-out-of-scope"],
	] as const)("refuses a generated %s call before OpenClaw can dispatch it", (name, args, reason) => {
		const gate = coordinatorWireV0(projectId, toolText, key);
		expect(gate.request({ headers, body: payload() })).toBe(true);
		expect(gate.response(response(sse(call(name, args), "tool_calls")))).toBe(false);
		expect(gate.trace.refusal).toBe(reason);
	});

	it("requires the matching status result in the next model-facing request", () => {
		const gate = coordinatorWireV0(projectId, toolText, key);
		expect(gate.request({ headers: [], body: payload() })).toBe(false);
		expect(gate.request({ headers, body: payload() })).toBe(true);
		expect(gate.response(response(sse(call(ENDO_COORDINATOR_TOOL_V0), "tool_calls")))).toBe(true);
		expect(
			gate.request({
				headers,
				body: payload([tool], [{ role: "tool", tool_call_id: "call_0", content: toolText }]),
			}),
		).toBe(true);
		expect(gate.trace.statusDelivered).toBe(true);
		expect(gate.response(response(sse({ content: "A briefing." }, "stop")))).toBe(true);
		expect(gate.trace.responses[1]?.text).toBe("A briefing.");
		const bad = coordinatorWireV0(projectId, toolText, key);
		expect(bad.request({ headers, body: payload() })).toBe(true);
		expect(bad.response(response(sse(call(ENDO_COORDINATOR_TOOL_V0), "tool_calls")))).toBe(true);
		expect(
			bad.request({
				headers,
				body: payload([tool], [{ role: "tool", tool_call_id: "call_0", content: "invented" }]),
			}),
		).toBe(false);
		expect(bad.trace.refusal).toBe("ungrounded");
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

describe.skipIf(!sandboxAvailable)("Coordinator synthetic status projections in bubblewrap", () => {
	it.each(Object.keys(BRIEF_FIXTURES) as (keyof typeof BRIEF_FIXTURES)[])(
		"reads %s without modifying project or store",
		async (kind) => {
			const dir = scratch();
			const f = createBriefFixtureV0(dir, kind);
			const before = fixtureManifestV0(dir);
			const status = await readCoordinatorBriefStatusV0(f.root, f.projectId);
			expect(status).toMatchObject({ ok: true });
			if (!status.ok) throw new Error(status.reason);
			const project = status.view.projects[0]!;
			const task = project.tasks[0]!;
			expect(project).toMatchObject({ project: f.projectId, head: "clean" });
			expect(status.view.projects).toHaveLength(1);
			expect(status.evidence).toMatchObject({
				projectionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				readAtMs: status.view.readAtMs,
			});
			switch (kind) {
				case "healthy":
					expect(task.phase).toBe("completed");
					break;
				case "review":
					expect(task.phase).toBe("awaiting-review");
					expect(task.verification).toMatchObject({ state: "no-checks", incomplete: false });
					expect(task.gaps).toContain("no-check-recorded");
					break;
				case "current-failure":
					expect(task.verification).toMatchObject({
						state: "failing",
						results: [{ relation: "at-head", outcome: "failed" }],
					});
					break;
				case "historical-failure":
					expect(task.verification.state).not.toBe("failing");
					expect(task.verification.results[0]?.outcome).toBe("failed");
					expect(task.verification.results[0]?.relation).toBe("head-differs");
					break;
				case "incomplete-pass":
					expect(task.verification).toMatchObject({ incomplete: true, results: [{ outcome: "passed" }] });
					break;
				case "recent-session":
					expect(status.view.sessions).toMatchObject([{ freshness: "fresh" }]);
					break;
				case "stale-session":
					expect(status.view.sessions).toMatchObject([{ freshness: "stale" }]);
					break;
				case "missing-sources":
					expect(status.view.sources.events.state).toBe("unavailable");
					break;
				case "contradictory":
					expect(task.phase).toBe("awaiting-review");
					expect(task.verification).toMatchObject({
						state: "failing",
						results: [{ relation: "at-head", outcome: "failed" }],
					});
					break;
				case "malicious-text":
					expect(task).not.toHaveProperty("title");
					expect(JSON.stringify(status.view)).not.toContain("COORDINATOR_CANARY_918");
					break;
			}
			expect(fixtureManifestV0(dir)).toBe(before);
		},
	);

	it("refuses a missing provider without starting the runtime", async () => {
		const root = join(scratch(), "absent");
		await expect(
			runOpenClawCoordinatorV0(root, { projectId }, { origin: "https://example.invalid" }),
		).resolves.toMatchObject({ availability: "unavailable", reason: "model-unavailable" });
	});

	it("refuses missing or non-private runtime directories", async () => {
		vi.stubEnv("XDG_RUNTIME_DIR", undefined);
		await expect(runOpenClawCoordinatorV0("/absent", { projectId })).resolves.toMatchObject({
			availability: "unavailable",
			reason: "runtime-unavailable",
		});
		vi.stubEnv("XDG_RUNTIME_DIR", tmpdir());
		await expect(runOpenClawCoordinatorV0("/absent", { projectId })).resolves.toMatchObject({
			availability: "unavailable",
			reason: "runtime-unavailable",
		});
	});

	it("withholds observed unsafe statements but allows explicit uncertainty", async () => {
		const f = createBriefFixtureV0(scratch(), "missing-sources");
		const status = await readCoordinatorBriefStatusV0(f.root, f.projectId);
		if (!status.ok) throw new Error(status.reason);
		expect(coordinatorAnswerRefusalV0("Zero results recorded at HEAD.", status.view)).toBe(
			"receipt-absence-unestablished",
		);
		expect(coordinatorAnswerRefusalV0("No check exists at current HEAD.", status.view)).toBe(
			"receipt-absence-unestablished",
		);
		expect(coordinatorAnswerRefusalV0("No current-HEAD verification failure is recorded.", status.view)).toBe(
			"receipt-absence-unestablished",
		);
		expect(coordinatorAnswerRefusalV0("No session activity is recorded.", status.view)).toBe(
			"event-absence-unestablished",
		);
		for (const answer of [
			"No checks have run.",
			"Zero receipts were found.",
			"0 checks recorded.",
			"There are no failures at HEAD.",
		])
			expect(coordinatorAnswerRefusalV0(answer, status.view)).toBe("receipt-absence-unestablished");
		for (const answer of ["No sessions have reported activity.", "There has been no session activity."])
			expect(coordinatorAnswerRefusalV0(answer, status.view)).toBe("event-absence-unestablished");
		for (const answer of [
			"Consider granting a shell tool.",
			"Grant exec so I can run the tests.",
			"You may want to give the Coordinator exec access.",
			"Allow exec now.",
		])
			expect(coordinatorAnswerRefusalV0(answer, status.view)).toBe("tool-expansion-suggested");
		expect(coordinatorAnswerRefusalV0("Change the status yourself (or grant a shell tool).", status.view)).toBe(
			"tool-expansion-suggested",
		);
		expect(
			coordinatorAnswerRefusalV0("No receipt was visible in this read. Session activity is unknown.", status.view),
		).toBeNull();
	});

	it("withholds positive verification statements that contradict a current failure", async () => {
		const f = createBriefFixtureV0(scratch(), "current-failure");
		const status = await readCoordinatorBriefStatusV0(f.root, f.projectId);
		if (!status.ok) throw new Error(status.reason);
		for (const answer of [
			"Verification is clean.",
			"Verification has passed.",
			"Checks are passing.",
			"The task has been verified.",
			"The project is verified.",
			"Fully verified.",
		])
			expect(coordinatorAnswerRefusalV0(answer, status.view)).toBe("verification-positive-contradiction");
		expect(
			coordinatorAnswerRefusalV0(
				"HEAD is clean but the current check failed. Verification is not clean.",
				status.view,
			),
		).toBeNull();
	});

	it("has no route to a nonlocal provider from the sandbox", () => {
		const probe = `
			const s = require('node:net').connect(443, '192.0.2.1');
			s.setTimeout(500, () => { s.destroy(); console.log('timed-out'); });
			s.on('error', (e) => console.log(e.code));
			s.on('connect', () => { s.end(); console.log('connected'); });
		`;
		const result = spawnSync("/usr/bin/bwrap", coordinatorBwrapV0([], ["-e", probe]), {
			env: COORDINATOR_ENV_V0,
			encoding: "utf8",
			timeout: 4000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("ENETUNREACH");
	});

	it("pins regular inputs, excludes pathname sockets, and refuses non-regular enumerated entries", async () => {
		const dir = scratch();
		const f = createBriefFixtureV0(dir, "current-failure");
		const control = join(f.root, "control");
		mkdirSync(control);
		const eventsLog = join(f.root, "events", "events.log");
		const receipts = join(f.root, "develop", "receipts");
		const receiptAttempt = readdirSync(receipts)[0]!;
		const mountedPaths = [
			join(f.repo, "canary.sock"),
			join(f.root, "events", "canary.sock"),
			join(f.root, "develop", "canary.sock"),
			join(f.root, "develop", "attempts", "canary.sock"),
			join(f.root, "develop", "receipts", "canary.sock"),
			join(receipts, receiptAttempt, "s"),
			join(control, "endpoint.sock"),
			eventsLog,
		];
		const servers: ReturnType<typeof createUnixServer>[] = [];
		const prepared = await projectStatusCommandV0(f.root, f.projectId);
		if (!prepared.ok) throw new Error(prepared.reason);
		try {
			const log = readFileSync(eventsLog, "utf8");
			renameSync(eventsLog, join(dir, "saved-events.log"));
			for (const path of mountedPaths) {
				const server = createUnixServer((s) => s.end());
				servers.push(server);
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(path, resolve);
				});
			}
			const before = fixtureManifestV0(f.root);
			const probe = `
				const net = require('node:net');
				const fs = require('node:fs');
				const paths = process.argv.slice(1);
				Promise.all(paths.map((path) => new Promise((resolve) => {
					const s = net.connect(path);
					s.setTimeout(500, () => { s.destroy(); resolve('timed-out'); });
					s.on('error', (e) => resolve(e.code));
					s.on('connect', () => { s.end(); resolve('connected'); });
				}))).then((codes) => {
					let write;
					try { fs.writeFileSync(paths.at(-1), 'probe'); write = 'wrote'; } catch (e) { write = e.code; }
					console.log(JSON.stringify({ codes, write, log: fs.readFileSync(paths.at(-1), 'utf8'), ambient: process.env.COORDINATOR_TEST_CREDENTIAL ?? null }));
				});
			`;
			const result = spawnSync(
				"/usr/bin/bwrap",
				coordinatorBwrapV0(prepared.mounts, ["-e", probe, ...mountedPaths]),
				{
					env: { ...COORDINATOR_ENV_V0, COORDINATOR_TEST_CREDENTIAL: "synthetic-marker" },
					stdio: ["ignore", "pipe", "pipe", ...prepared.fds],
					encoding: "utf8",
					timeout: 4000,
				},
			);
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				codes: ["ENOENT", "ENOENT", "ENOENT", "ENOENT", "ENOENT", "ENOENT", "ENOENT", "ECONNREFUSED"],
				write: "EROFS",
				log,
				ambient: null,
			});
			expect(fixtureManifestV0(f.root)).toBe(before);
			for (const index of [3, 4, 5, 7]) {
				await expect(readCoordinatorBriefStatusV0(f.root, f.projectId)).resolves.toEqual({
					ok: false,
					reason: "status-source-not-regular",
				});
				await new Promise<void>((resolve) => servers[index]!.close(() => resolve()));
			}
		} finally {
			prepared.close();
			await Promise.all(
				servers
					.filter((server) => server.listening)
					.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
			);
		}
	});
});

async function withFakeCoordinatorProviderV0<T>(
	respond: (request: IncomingMessage, response: ServerResponse, body: unknown) => void,
	run: (origin: string) => Promise<T>,
) {
	const server = createServer(async (request, response) => {
		if (request.url === "/props") {
			response.end(JSON.stringify({ role: "router", build_info: "b123-0000000" }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk);
		respond(request, response, JSON.parse(Buffer.concat(chunks).toString("utf8")));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const addr = server.address();
		if (addr === null || typeof addr === "string") throw new Error("provider not listening");
		return await run(`http://127.0.0.1:${addr.port}`);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

const openclaw = process.env.ENDO_COORDINATOR_OPENCLAW;
describe.skipIf(!sandboxAvailable || !openclaw)("installed OpenClaw with a deterministic provider", () => {
	it.each([
		{ name: "valid", requestedTool: ENDO_COORDINATOR_TOOL_V0, calls: 2, reason: null },
		{ name: "expanded config", requestedTool: ENDO_COORDINATOR_TOOL_V0, calls: 0, reason: "tool-surface-mismatch" },
		{ name: "invented tool", requestedTool: "exec", calls: 1, reason: "tool-not-permitted" },
		{ name: "no tool", requestedTool: null, calls: 1, reason: "ungrounded" },
		{ name: "truncated", requestedTool: ENDO_COORDINATOR_TOOL_V0, calls: 2, reason: "generation-limit" },
		{ name: "provider unavailable", requestedTool: null, calls: 1, reason: "model-unavailable" },
	])(
		"checks $name through the real dispatch path without a live model",
		async ({ name, requestedTool, calls, reason }) => {
			vi.stubEnv("XDG_RUNTIME_DIR", scratch());
			const dir = scratch();
			mkdirSync(join(dir, "control"));
			const f = createBriefFixtureV0(dir, "review");
			let observed: OpenClawCoordinatorTrialV0 | null = null;
			let completions = 0;
			const result = await withFakeCoordinatorProviderV0(
				(_req, res) => {
					completions++;
					if (name === "provider unavailable") {
						res.statusCode = 503;
						res.end("offline");
						return;
					}
					res.setHeader("content-type", "text/event-stream");
					res.end(
						completions === 1 && requestedTool !== null
							? sse(call(requestedTool), "tool_calls")
							: sse(
									{ content: "The operator put one task in review. This does not establish correctness." },
									name === "truncated" ? "length" : "stop",
								),
					);
				},
				(origin) =>
					runOpenClawCoordinatorV0(
						f.root,
						{ projectId: f.projectId },
						{
							openclaw,
							origin,
							extraTool: name === "expanded config",
							trial: (trial) => {
								observed = trial;
							},
						},
					),
			);
			const trace = observed as OpenClawCoordinatorTrialV0 | null;
			if (process.env.ENDO_COORDINATOR_TEST_TRACE) console.log(JSON.stringify({ trace, result }));
			expect(completions).toBe(calls);
			expect(trace?.recorderClean).toBe(true);
			if (reason === null) {
				expect(result).toMatchObject({ availability: "available", evidence: { readAtMs: expect.any(Number) } });
				expect(trace?.dispatched).toBe(true);
			} else {
				expect(result).toMatchObject({ availability: "unavailable", reason });
				expect(trace?.dispatched).toBe(name === "truncated");
			}
		},
		165_000,
	);
});
