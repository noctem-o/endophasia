// EVAL-ISO-003 (docs/protected-model-access.md §9): `endo experiment protected-run` with a model-connected (version 1) spec, run in REAL
// Bubblewrap sandboxes under systemd scopes, against a disposable fake model server on this host's loopback. Skipped, and said so, where the
// host cannot isolate (as tests/protected-isolation.test.ts).
//
// Each test is one run of the real runner: the boundary checked from inside (with the relay's two probes), the agent reaching the model
// only through its attempt's relay, its recording closed and summarized, the submission evaluated in a separate offline sandbox, and the
// report reading every record again against the recording on disk. The agents are small node scripts: harness-neutral, and each does
// exactly one thing the test is about (an honest agent, an adversary, one that never calls the model, one past the exchange bound).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { detectBubblewrapV0 } from "../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0 } from "../adapters/sandbox/containment.ts";
import {
	EndoProtectedRefusalV0,
	reportProtectedExperimentV0,
	runProtectedExperimentV0,
} from "../cli/experiment-protected.ts";
import {
	type EndoProtectedSpecV1,
	type EndoProtectedTrial,
	type EndoProtectedTrialV0,
	type EndoProtectedTrialV1,
	endoProtectedTrialOutcomeV0,
	readEndoProtectedSpecV0,
} from "../protocol/protected-experiment.ts";
import { makePiAgentDirectoryV1, piExampleSpecV1 } from "../research/protected-eval/model-connected/pi-condition.ts";
import { readEndoProtectedTrialFileV0, sealEndoProtectedTrialV0 } from "../runtime/contracts/protected-experiment.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";

const EXAMPLE = fileURLToPath(new URL("../research/protected-eval/example/", import.meta.url));
const KILL = fileURLToPath(new URL("./fixtures/protected-kill-before-relay-close.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-model-run-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const d = join(base, `${name}-${made}`);
	mkdirSync(d, { recursive: true });
	return d;
};
const detected = detectBubblewrapV0();
const contained = detected.ok ? await detectContainmentV0() : null;
const REAL = detected.ok && contained?.ok === true && process.env.XDG_RUNTIME_DIR !== undefined;
if (!REAL)
	process.stderr.write(
		"protected-model-run: real isolation tests skipped (no bubblewrap, user manager or runtime dir)\n",
	);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const SOLUTION = readFileSync(join(EXAMPLE, "evaluator", "reference", "src", "interval.mjs"), "utf8");
const MODEL = "fake-1";

/** What every test agent starts with: a way to ask the model through the bridge, as the environment names it, and the solution. */
const PRELUDE = `
import http from "node:http"; import fs from "node:fs"; import net from "node:net";
const origin = new URL(process.env.ENDO_MODEL_ORIGIN);
const MODEL = process.env.ENDO_MODEL_ID;
const MAX = Number(process.env.ENDO_MODEL_MAX_COMPLETION_TOKENS);
const ask = (body, path = "/v1/chat/completions", method = "POST") => new Promise((resolve) => {
	const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
	const req = http.request({ host: origin.hostname, port: Number(origin.port), path, method, agent: false,
		headers: data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
		res.resume(); res.on("end", () => resolve(String(res.statusCode))); res.on("error", (e) => resolve(e.code || "error"));
	});
	req.on("error", (e) => resolve(e.code || "error"));
	if (data !== undefined) req.write(data);
	req.end();
});
const chat = (extra = {}) => ({ model: MODEL, stream: false, max_tokens: MAX, messages: [{ role: "user", content: "Say hello" }], ...extra });
const reach = (opts) => new Promise((resolve) => { const s = net.connect(opts); const t = setTimeout(() => { s.destroy(); resolve("timeout"); }, 2000);
	s.on("connect", () => { clearTimeout(t); s.destroy(); resolve("connected"); }); s.on("error", (e) => { clearTimeout(t); resolve(e.code); }); });
const code = (f) => { try { f(); return "ok"; } catch (e) { return e.code || "error"; } };
const solve = () => { fs.mkdirSync("src", { recursive: true }); fs.writeFileSync("src/interval.mjs", ${JSON.stringify(SOLUTION)}); };
`;

type Access = EndoProtectedSpecV1["modelAccess"];

/** A version 1 spec over the committed example's evaluator (copied, so its pin is this copy's), with one condition per agent. */
function specWith(
	agents: Record<string, string>,
	upstream: string,
	access: Partial<Access> = {},
	trials = 1,
): { spec: EndoProtectedSpecV1; evaluatorDir: string } {
	const evaluatorDir = fresh("evaluator");
	for (const part of ["reference", "negative"]) {
		mkdirSync(join(evaluatorDir, part, "src"), { recursive: true });
		writeFileSync(
			join(evaluatorDir, part, "src", "interval.mjs"),
			readFileSync(join(EXAMPLE, "evaluator", part, "src", "interval.mjs")),
		);
	}
	writeFileSync(join(evaluatorDir, "evaluator.json"), readFileSync(join(EXAMPLE, "evaluator", "evaluator.json")));
	const conditions = Object.entries(agents).map(([id, source]) => {
		const dir = fresh(`agent-${id}`);
		writeFileSync(join(dir, "agent.mjs"), PRELUDE + source);
		return { id, description: id, agent: { directory: dir, argv: ["/usr/bin/node", "/agent/agent.mjs"] } };
	});
	const read = readEndoProtectedSpecV0({
		schemaVersion: "endo.protected-experiment-spec.v1",
		id: "endo.experiment.model-run-test",
		description: "test",
		seed: 7,
		trials,
		limits: {
			agentTimeoutMs: 20_000,
			evaluationTimeoutMs: 20_000,
			outputBytes: 1_048_576,
			tmpfsBytes: 16_777_216,
			maxFileBytes: 65_536,
			maxTotalBytes: 262_144,
			memoryMaxBytes: 512 * 1024 * 1024,
			cpuQuotaPercent: 200,
		},
		runtime: { executables: ["/usr/bin/node"], aliases: [] },
		tasks: [
			{
				id: "merge-intervals",
				workspace: { "README.md": "task\n" },
				submission: ["src/interval.mjs"],
				evaluator: {
					file: join(evaluatorDir, "evaluator.json"),
					sha256: sha(join(evaluatorDir, "evaluator.json")),
				},
			},
		],
		conditions,
		modelAccess: {
			upstream,
			model: MODEL,
			routes: [{ method: "POST", path: "/v1/chat/completions" }],
			maxRequestBytes: 256 * 1024,
			maxTransferredBytes: 16 * 1024 * 1024,
			maxConnections: 8,
			maxTotalConnections: 64,
			maxExchanges: 32,
			maxCompletionTokens: 64,
			minExchanges: 1,
			...access,
		},
	});
	if (!read.ok) throw new Error(read.message);
	return { spec: read.value as EndoProtectedSpecV1, evaluatorDir };
}

const attemptDir = (out: string, condition: string, trial = 0, attempt = 1) =>
	join(out, "trials", "merge-intervals", condition, String(trial), `attempt-${attempt}`);
const recordOf = (out: string, condition: string, trial = 0, attempt = 1): EndoProtectedTrialV1 => {
	const r = readEndoProtectedTrialFileV0(join(attemptDir(out, condition, trial, attempt), "record.json"));
	if (!r.ok) throw new Error(r.reason);
	expect(r.value.schemaVersion).toBe("endo.protected-trial.v1");
	return r.value as EndoProtectedTrialV1;
};
const cellOf = (out: string, condition: string) => {
	const report = reportProtectedExperimentV0(out);
	return { report, cell: report.cells.find((c) => c.condition === condition)! };
};
/** The relay and session directories this runner makes directly under the user's runtime directory. */
const runtimeLeftovers = () =>
	readdirSync(process.env.XDG_RUNTIME_DIR as string).filter((n) => /^endo-(relay|run)-/.test(n));

async function withUpstream<T>(f: (upstream: FakeOpenAiServer) => Promise<T>): Promise<T> {
	const upstream = await startFakeOpenAiServer();
	try {
		return await f(upstream);
	} finally {
		await upstream.close();
	}
}

describe.runIf(REAL)("EVAL-ISO-003 real isolation: a model-connected protected run", () => {
	it("an honest agent reaches the model only through its relay, passes, and every record verifies against its recording", async () => {
		await withUpstream(async (upstream) => {
			const before = runtimeLeftovers();
			const out = fresh("run");
			const { spec } = specWith(
				{
					honest: `const a = await ask(chat()); const b = await ask(chat()); console.log("ASKED", a, b); solve();`,
				},
				new URL(upstream.baseUrl).origin,
			);
			await runProtectedExperimentV0({ spec, dir: out });
			const r = recordOf(out, "honest");
			// The boundary, checked from inside in the agent's own (logical) profile, with the relay's two probes.
			expect(r.preflight.status).toBe("established");
			expect(r.preflight.probes.find((p) => p.id === "net-model-relay")).toMatchObject({
				passed: true,
				observed: "connected",
			});
			expect(r.preflight.probes.find((p) => p.id === "net-model-server-direct")).toMatchObject({
				passed: true,
				observed: "ECONNREFUSED",
			});
			expect(r.preflight.probes.find((p) => p.id === "net-host-loopback")).toMatchObject({ passed: true });
			expect(r.isolation.requested.network).toBe("model-relay");
			expect(r.isolation.limits).toEqual({ memoryMaxBytes: 512 * 1024 * 1024, cpuQuotaPercent: 200 });
			// The relay ran, recorded completely, and forwarded exactly what its judge admitted.
			expect(r.network.relay).toMatchObject({ status: "ran", admitted: 2, recordingFailures: 0 });
			expect(r.recording.status).toBe("complete");
			expect(r.recording.exchanges.map((e) => [e.class, e.status, e.verified])).toEqual([
				["answered", 200, true],
				["answered", 200, true],
			]);
			expect(upstream.completionRequests()).toHaveLength(2);
			// Evaluated independently, offline; a pass.
			expect(r.agent).toMatchObject({ status: "completed", termination: "confirmed" });
			expect(r.evaluation.status).toBe("passed");
			expect(endoProtectedTrialOutcomeV0(r)).toEqual({ outcome: "passed", reason: null });
			// The recording is private: its directory 0700, its key 0600.
			expect(statSync(join(attemptDir(out, "honest"), "model")).mode & 0o777).toBe(0o700);
			expect(statSync(join(attemptDir(out, "honest"), "model", "digest-key")).mode & 0o777).toBe(0o600);
			// The report reads the record again against the recording, and counts it.
			const { report, cell } = cellOf(out, "honest");
			expect(report.schemaVersion).toBe("endo.protected-report.v1");
			expect(report.refusedRecords).toEqual([]);
			expect(cell).toMatchObject({ planned: 1, qualified: 1, passed: 1, failed: 0, failedBelowMinimumExchanges: 0 });
			expect(report.modelAccess).toMatchObject({ model: MODEL, minExchanges: 1 });
			// Nothing of the relay or the session is left in the runtime directory.
			expect(runtimeLeftovers()).toEqual(before);
		});
	});

	it("an adversarial agent: every undeclared route, model, unbounded generation and direct path is refused, and nothing hidden is visible", async () => {
		await withUpstream(async (upstream) => {
			const out = fresh("run");
			const port = Number(new URL(upstream.baseUrl).port);
			const evaluatorPlaceholder = "@EVALUATOR@";
			const { spec, evaluatorDir } = specWith(
				{
					adversary: `
const o = {};
o.loadModel = await ask({ model: "other" }, "/models/load");
o.listModels = await ask(undefined, "/v1/models", "GET");
o.slots = await ask(undefined, "/slots", "GET");
o.otherModel = await ask(chat({ model: "other" }));
const { max_tokens, ...unbounded } = chat();
o.noBound = await ask(unbounded);
o.overBound = await ask(chat({ max_tokens: MAX + 1 }));
o.severalChoices = await ask(chat({ n: 4 }));
o.prefix = await ask(chat(), "/v1/chat/completions/");
o.query = await ask(chat(), "/v1/chat/completions?x=1");
o.directModelServer = await reach({ host: "127.0.0.1", port: ${port} });
o.internet = await reach({ host: "192.0.2.1", port: 80 });
o.evaluator = code(() => fs.readFileSync("${evaluatorPlaceholder}"));
o.runDirectory = code(() => fs.readdirSync("${base}"));
o.runtimeDir = code(() => fs.readdirSync("${process.env.XDG_RUNTIME_DIR}"));
o.relayDir = fs.readdirSync("/run/endo").sort().join(",");
o.writeRelayDir = code(() => fs.writeFileSync("/run/endo/x", "x"));
o.env = Object.keys(process.env).sort().join(",");
o.valid = await ask(chat());
console.log("OBSERVED " + JSON.stringify(o));
solve();`,
				},
				new URL(upstream.baseUrl).origin,
			);
			// The evaluator's host path, which the agent must not reach (written into its script after the spec pinned the evaluator).
			const agentFile = join(spec.conditions[0]!.agent.directory, "agent.mjs");
			writeFileSync(
				agentFile,
				readFileSync(agentFile, "utf8").replace(evaluatorPlaceholder, join(evaluatorDir, "evaluator.json")),
			);
			await runProtectedExperimentV0({ spec, dir: out });
			const log = readFileSync(join(attemptDir(out, "adversary"), "agent.log"), "utf8");
			const observed = JSON.parse(/OBSERVED (.*)/.exec(log)?.[1] ?? "{}");
			for (const k of [
				"loadModel",
				"listModels",
				"slots",
				"otherModel",
				"noBound",
				"overBound",
				"severalChoices",
				"prefix",
				"query",
			])
				expect(observed[k], k).toMatch(/^(ECONNRESET|EPIPE|socket hang up)$/);
			expect(observed).toMatchObject({
				directModelServer: "ECONNREFUSED",
				internet: "ENETUNREACH",
				evaluator: "ENOENT",
				runDirectory: "ENOENT",
				runtimeDir: "ENOENT",
				relayDir: "bridge.cjs,model.sock",
				writeRelayDir: "EROFS",
				env: "ENDO_MODEL_ID,ENDO_MODEL_MAX_COMPLETION_TOKENS,ENDO_MODEL_ORIGIN,HOME,PATH,PWD,TMPDIR",
				valid: "200",
			});
			// The model server saw exactly the one admitted request.
			expect(upstream.requests.map((q) => `${q.method} ${q.url}`)).toEqual(["POST /v1/chat/completions"]);
			const r = recordOf(out, "adversary");
			expect(r.network.relay.admitted).toBe(1);
			// route: /models/load, a trailing slash, a query string. unjudged: the two bodiless GETs, refused before the judge.
			expect(r.network.relay.refusals).toMatchObject({ model: 1, generation: 3, route: 3, unjudged: 2 });
			// A refused request is the agent's own doing: the trial is judged on its submission (here, a pass).
			expect(r.invalidating).toEqual([]);
			expect(endoProtectedTrialOutcomeV0(r).outcome).toBe("passed");
			expect(r.recording.exchanges.filter((e) => e.class === "refused").length).toBeGreaterThan(0);
			const { report } = cellOf(out, "adversary");
			expect(report.refusedRecords).toEqual([]);
		});
	});

	it("an agent that never calls the model and still passes the evaluator is a failure for too few model exchanges", async () => {
		await withUpstream(async (upstream) => {
			const out = fresh("run");
			const { spec } = specWith({ silent: "solve();" }, new URL(upstream.baseUrl).origin);
			await runProtectedExperimentV0({ spec, dir: out });
			const r = recordOf(out, "silent");
			// The evaluator's fact is kept: it passed. The outcome is not a pass.
			expect(r.evaluation.status).toBe("passed");
			expect(r.recording).toMatchObject({ status: "complete", exchanges: [], required: 1 });
			expect(endoProtectedTrialOutcomeV0(r)).toEqual({ outcome: "failed", reason: "model-exchanges-below-minimum" });
			const { cell, report } = cellOf(out, "silent");
			expect(report.refusedRecords).toEqual([]);
			expect(cell).toMatchObject({
				qualified: 1,
				passed: 0,
				failed: 1,
				failedBelowMinimumExchanges: 1,
				failedWithoutSubmission: 0,
			});
		});
	});

	it("past the exchange bound, requests are refused and the model server never sees them", async () => {
		await withUpstream(async (upstream) => {
			const out = fresh("run");
			const { spec } = specWith(
				{
					greedy: `const r = []; for (let i = 0; i < 4; i++) r.push(await ask(chat())); console.log("ASKED " + r.join(",")); solve();`,
				},
				new URL(upstream.baseUrl).origin,
				{ maxExchanges: 2, minExchanges: 2 },
			);
			await runProtectedExperimentV0({ spec, dir: out });
			expect(readFileSync(join(attemptDir(out, "greedy"), "agent.log"), "utf8")).toMatch(
				/ASKED 200,200,(ECONNRESET|EPIPE),(ECONNRESET|EPIPE)/,
			);
			expect(upstream.completionRequests()).toHaveLength(2);
			const r = recordOf(out, "greedy");
			expect(r.network.relay).toMatchObject({ admitted: 2, refusals: { exchanges: 2 } });
			expect(endoProtectedTrialOutcomeV0(r).outcome).toBe("passed");
			expect(cellOf(out, "greedy").report.refusedRecords).toEqual([]);
		});
	});

	it("an agent killed at its deadline mid-response: the exchange still in flight is recorded to its end before the record is written", async () => {
		const upstream = await startFakeOpenAiServer({ slowChunkMs: 1000 });
		try {
			const out = fresh("run");
			const { spec } = specWith(
				{
					hangs: `solve();
const body = JSON.stringify(chat({ stream: true, messages: [{ role: "user", content: "count to forty" }] }));
const req = http.request({ host: origin.hostname, port: Number(origin.port), path: "/v1/chat/completions", method: "POST", agent: false,
	headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => res.once("data", () => console.log("STREAMING")));
req.end(body);
setInterval(() => {}, 1000);`,
				},
				new URL(upstream.baseUrl).origin,
			);
			await runProtectedExperimentV0({
				spec: { ...spec, limits: { ...spec.limits, agentTimeoutMs: 4000 } },
				dir: out,
			});
			const r = recordOf(out, "hangs");
			expect(readFileSync(join(attemptDir(out, "hangs"), "agent.log"), "utf8")).toMatch(/STREAMING/);
			expect(r.agent).toMatchObject({ status: "timed-out", termination: "confirmed" });
			// The response was still streaming when the sandbox was killed: its end is in the recording, which is complete.
			expect(r.recording.exchanges.map((e) => [e.class, e.verified])).toEqual([["client-disconnected", true]]);
			expect(r.recording.status).toBe("complete");
			// A timed-out agent's submission is still judged; its one exchange was not a successful one.
			expect(endoProtectedTrialOutcomeV0(r)).toEqual({ outcome: "failed", reason: "model-exchanges-below-minimum" });
			expect(cellOf(out, "hangs").report.refusedRecords).toEqual([]);
		} finally {
			await upstream.close();
		}
	});

	it("a model server that fails a forwarded request is attrition (model-upstream-error), never the agent's failure", async () => {
		const gone = await startFakeOpenAiServer();
		const origin = new URL(gone.baseUrl).origin;
		await gone.close();
		const out = fresh("run");
		const { spec } = specWith({ asker: `console.log("ASKED " + (await ask(chat()))); solve();` }, origin);
		await runProtectedExperimentV0({ spec, dir: out });
		const r = recordOf(out, "asker");
		expect(r.recording.exchanges.map((e) => e.class)).toEqual(["model-failed"]);
		expect(r.invalidating).toEqual(["model-upstream-error"]);
		const { cell } = cellOf(out, "asker");
		expect(cell).toMatchObject({ qualified: 0, attrition: { "model-upstream-error": 1 } });
	});

	it("a relay that cannot start: the agent never runs, the attempt is attrition, and it is not retried", async () => {
		await withUpstream(async (upstream) => {
			const out = fresh("run");
			const { spec } = specWith(
				{ never: `fs.writeFileSync("ran", "yes"); solve();` },
				new URL(upstream.baseUrl).origin,
			);
			await runProtectedExperimentV0({ spec, dir: out, relayFailsForTests: true });
			const r = recordOf(out, "never");
			expect(r.network.relay.status).toBe("failed-to-start");
			expect(r.agent.status).toBe("not-run");
			expect(r.invalidating).toEqual(["relay-unavailable"]);
			expect(existsSync(join(attemptDir(out, "never"), "work", "ran"))).toBe(false);
			// Not retryable: only an attempt the controller stopped before its agent started is.
			const again = await runProtectedExperimentV0({ spec, dir: out, retryInterrupted: true });
			expect(again).toMatchObject({ attempts: 0, skipped: 1 });
		});
	});

	it("a weakened boundary (the host's network shared) fails the relay's probe: no relay starts, the agent never runs", async () => {
		await withUpstream(async (upstream) => {
			const out = fresh("run");
			const { spec } = specWith({ weak: "solve();" }, new URL(upstream.baseUrl).origin);
			await runProtectedExperimentV0({ spec, dir: out, unsafeForTests: { weak: { shareNet: true } } });
			const r = recordOf(out, "weak");
			expect(r.preflight.status).toBe("failed");
			expect(r.preflight.probes.find((p) => p.id === "net-model-server-direct")).toMatchObject({ passed: false });
			expect(r.network.relay.status).toBe("not-started");
			expect(r.agent.status).toBe("not-run");
			expect(upstream.requests).toHaveLength(0);
		});
	});

	it("the reader refuses records that do not match their own evidence: tampered, cross-contaminated, or of another version", async () => {
		await withUpstream(async (upstream) => {
			const out = fresh("run");
			const { spec } = specWith({ honest: "await ask(chat()); solve();" }, new URL(upstream.baseUrl).origin, {}, 4);
			await runProtectedExperimentV0({ spec, dir: out });
			expect(reportProtectedExperimentV0(out).refusedRecords).toEqual([]);
			const reseal = (trial: number, change: (r: Record<string, any>) => void) => {
				const path = join(attemptDir(out, "honest", trial), "record.json");
				const r = recordOf(out, "honest", trial) as unknown as Record<string, any>;
				const { recordSha256: _s, ...rest } = r;
				change(rest);
				rmSync(path);
				writeFileSync(path, JSON.stringify(sealEndoProtectedTrialV0(rest as never)));
			};
			// Trial 0: the record claims a different request than the one recorded (resealed, so only the evidence can tell).
			reseal(0, (r) => {
				r.recording.exchanges[0].requestSha256 = "0".repeat(64);
			});
			// Trial 1: another attempt's recording and key copied in (cross-contamination): a different domain and exchanges.
			for (const name of ["digest-key", "store"]) {
				rmSync(join(attemptDir(out, "honest", 1), "model", name), { recursive: true, force: true });
				cpSync(
					join(attemptDir(out, "honest", 2), "model", name),
					join(attemptDir(out, "honest", 1), "model", name),
					{
						recursive: true,
					},
				);
			}
			// Trial 2: the record names another policy than the run declares.
			reseal(2, (r) => {
				r.network.relay.policySha256 = "0".repeat(64);
			});
			// Trial 3: replaced by an offline (version 0) record, sealed and self-consistent, of the same attempt.
			reseal(3, (r) => {
				r.schemaVersion = "endo.protected-trial.v0";
				delete r.recording;
				delete r.isolation.limits;
				delete r.agent.scope.result;
				r.network = { mode: "none", relay: null, status: "established" };
				r.isolation.requested.network = "none";
				r.isolation.requested.mounts = r.isolation.requested.mounts.filter(
					(m: { kind: string; role: string }) => m.kind !== "socket" && m.role !== "model-bridge",
				);
			});
			const v0 = readEndoProtectedTrialFileV0(join(attemptDir(out, "honest", 3), "record.json"));
			expect(v0.ok && (v0.value as EndoProtectedTrial as EndoProtectedTrialV0).schemaVersion).toBe(
				"endo.protected-trial.v0",
			);
			const { report, cell } = cellOf(out, "honest");
			const reasons = Object.fromEntries(report.refusedRecords.map((x) => [x.path.split("/")[3], x.reason]));
			expect(reasons).toEqual({
				"0": expect.stringMatching(/not the ones the recording shows/),
				"1": expect.stringMatching(/digest domain|not the ones/),
				"2": expect.stringMatching(/another policy/),
				"3": expect.stringMatching(/version is not the run's/),
			});
			expect(cell).toMatchObject({ planned: 4, qualified: 0, passed: 0, attrition: { "record-refused": 4 } });
		});
	});

	it("a resume is refused under a changed model policy, or with an offline spec over a model-connected run", async () => {
		await withUpstream(async (upstream) => {
			const out = fresh("run");
			const { spec } = specWith({ honest: "await ask(chat()); solve();" }, new URL(upstream.baseUrl).origin, {}, 2);
			await runProtectedExperimentV0({ spec, dir: out, maxAttempts: 1 });
			const changed = { ...spec, modelAccess: { ...spec.modelAccess, maxCompletionTokens: 65 } };
			await expect(runProtectedExperimentV0({ spec: changed, dir: out })).rejects.toThrow(/identical spec/);
			const otherModel = { ...spec, modelAccess: { ...spec.modelAccess, model: "fake-2" } };
			await expect(runProtectedExperimentV0({ spec: otherModel, dir: out })).rejects.toThrow(/identical spec/);
			const { modelAccess: _m, ...rest } = spec;
			const offline = readEndoProtectedSpecV0({
				...rest,
				schemaVersion: "endo.protected-experiment-spec.v0",
				limits: { ...spec.limits, memoryMaxBytes: undefined, cpuQuotaPercent: undefined },
				runtime: { executables: spec.runtime.executables },
			});
			// A version 0 spec with the version 1 limit fields is refused by the reader; without them, by the runner.
			expect(offline.ok).toBe(false);
			const { memoryMaxBytes: _a, cpuQuotaPercent: _b, ...limits } = spec.limits;
			const v0 = readEndoProtectedSpecV0({
				...rest,
				schemaVersion: "endo.protected-experiment-spec.v0",
				limits,
				runtime: { executables: spec.runtime.executables },
			});
			if (!v0.ok) throw new Error(v0.message);
			await expect(runProtectedExperimentV0({ spec: v0.value, dir: out })).rejects.toThrow(EndoProtectedRefusalV0);
			await expect(runProtectedExperimentV0({ spec: v0.value, dir: out })).rejects.toThrow(/cannot resume it/);
			// The unchanged spec still resumes, and finishes the plan.
			expect(await runProtectedExperimentV0({ spec, dir: out })).toMatchObject({ attempts: 1, skipped: 1 });
			expect(reportProtectedExperimentV0(out).refusedRecords).toEqual([]);
		});
	});

	it("a controller killed after its agent ended and before its relay closed: the resume keeps the agent's facts, the recording is unknown, and the trial is final attrition", async () => {
		await withUpstream(async (upstream) => {
			const before = runtimeLeftovers();
			const out = fresh("run");
			const { spec } = specWith({ honest: "await ask(chat()); solve();" }, new URL(upstream.baseUrl).origin);
			const specFile = join(fresh("spec"), "spec.json");
			writeFileSync(specFile, JSON.stringify(spec));
			const child = spawn(process.execPath, [KILL, specFile, out], { stdio: "ignore" });
			const signal = await new Promise<string | null>((done) => child.on("exit", (_code, s) => done(s)));
			expect(signal).toBe("SIGKILL");
			expect(existsSync(join(attemptDir(out, "honest"), "relay.json"))).toBe(true);
			expect(existsSync(join(attemptDir(out, "honest"), "model-ended.json"))).toBe(false);
			// The killed controller left its relay's and its session's directories behind.
			expect(runtimeLeftovers().length).toBeGreaterThan(before.length);
			const summary = await runProtectedExperimentV0({ spec, dir: out, retryInterrupted: true });
			expect(summary).toMatchObject({ finalizedOnResume: 1, attempts: 0, skipped: 1 });
			const r = recordOf(out, "honest");
			expect(r.controller.finalized).toBe("on-resume");
			expect(r.agent).toMatchObject({ status: "completed", termination: "confirmed" });
			expect(r.network.relay).toMatchObject({ status: "interrupted", admitted: null, recordingFailures: null });
			expect(r.recording.status).toBe("unknown");
			expect(r.invalidating).toEqual(["controller-interrupted"]);
			// The resume removed what the killed controller left in the runtime directory.
			expect(runtimeLeftovers()).toEqual(before);
			const { report, cell } = cellOf(out, "honest");
			expect(report.refusedRecords).toEqual([]);
			expect(cell).toMatchObject({ qualified: 0, attrition: { "controller-interrupted": 1 } });
		});
	});
});

// ---- real Pi, through protected-run (opt-in) ---------------------------------------------------------------------------------------------

const PI_DIST = process.env.ENDO_PI_DIST ?? "";

describe.runIf(REAL && PI_DIST.length > 0)(
	"EVAL-ISO-003 real isolation: real Pi as a condition of protected-run (ENDO_PI_DIST), against a fake model",
	() => {
		it("Pi, configured only by its own launcher from the declared environment, writes the solution with its bash tool and passes", async () => {
			const command = `cat > src/interval.mjs <<'ENDO_EOF'\n${SOLUTION}ENDO_EOF`;
			const upstream = await startFakeOpenAiServer({
				toolScript: { steps: [{ name: "bash", arguments: JSON.stringify({ command }) }], finalText: "done" },
			});
			try {
				const agentDirectory = join(fresh("pi"), "agent");
				makePiAgentDirectoryV1(PI_DIST, agentDirectory);
				const read = readEndoProtectedSpecV0(
					piExampleSpecV1({
						agentDirectory,
						upstream: new URL(upstream.baseUrl).origin,
						model: MODEL,
						maxCompletionTokens: 512,
						maxExchanges: 8,
					}),
				);
				if (!read.ok) throw new Error(read.message);
				const out = fresh("run");
				await runProtectedExperimentV0({ spec: read.value, dir: out });
				const path = join(out, "trials", "merge-intervals", "pi", "0", "attempt-1");
				const r = readEndoProtectedTrialFileV0(join(path, "record.json"));
				if (!r.ok) throw new Error(r.reason);
				const v = r.value as EndoProtectedTrialV1;
				const log = readFileSync(join(path, "agent.log"), "utf8");
				expect(v.agent, log.slice(-2000)).toMatchObject({ status: "completed", termination: "confirmed" });
				// Every request Pi sent stated the declared bound (it is the launcher's maxTokens), so none was refused.
				expect(Object.values(v.network.relay.refusals ?? {}).every((n) => n === 0)).toBe(true);
				for (const q of upstream.completionRequests())
					expect((q.body as { max_completion_tokens?: number }).max_completion_tokens).toBe(512);
				expect(v.recording.status).toBe("complete");
				expect(v.recording.exchanges.length).toBeGreaterThanOrEqual(2);
				expect(v.recording.exchanges.every((e) => e.class === "answered" && e.status === 200)).toBe(true);
				expect(v.evaluation.status).toBe("passed");
				expect(endoProtectedTrialOutcomeV0(v)).toEqual({ outcome: "passed", reason: null });
				const report = reportProtectedExperimentV0(out);
				expect(report.refusedRecords).toEqual([]);
				expect(report.cells[0]).toMatchObject({ qualified: 1, passed: 1 });
			} finally {
				await upstream.close();
			}
		});
	},
);
