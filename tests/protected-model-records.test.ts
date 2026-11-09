// EVAL-ISO-003 (docs/protected-model-access.md §9): model-connected protected experiments, the parts that run everywhere.
//
// - the judge's generation bound (refused, never rewritten), and that a policy without one keeps its earlier digest;
// - the version 1 spec: model access declared, opt-in by version, loopback only, bounded;
// - the version 1 trial record: its consistency rules, its invalidating conditions, and its outcome (too few model exchanges is a judged
//   failure, never a pass); version 0 and version 1 never read as each other;
// - the independent reader's evidence check (adapters/sandbox/model-evidence.ts) over a real relay's recording on this host: what it
//   accepts, and each tampering or contradiction it refuses.
// The same runs inside real sandboxes are in tests/protected-model-run.test.ts.
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import {
	exchangesOutsidePolicyV0,
	successfulExchangeV0,
	summarizeModelRecordingV0,
	verifyModelEvidenceV0,
} from "../adapters/sandbox/model-evidence.ts";
import {
	admitModelRequestV0,
	ENDO_PI_MODEL_ROUTES_V0,
	type EndoModelRelayPolicyV0,
	type EndoModelRelayV0,
	modelRelayPolicyDigestV0,
	startModelRelayV0,
} from "../adapters/sandbox/model-relay.ts";
import { endoSubmissionDigestV0 } from "../adapters/sandbox/submission.ts";
import {
	type EndoProtectedTrialV0,
	type EndoProtectedTrialV1,
	endoProtectedTrialOutcomeV0,
	readEndoProtectedRunV0,
	readEndoProtectedSpecV0,
} from "../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { checkEndoProtectedTrialV0, sealEndoProtectedTrialV0 } from "../runtime/contracts/protected-experiment.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";

const H = (c: string) => c.repeat(64);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-model-records-")));
const runtimeBase = (() => {
	const xdg = process.env.XDG_RUNTIME_DIR;
	const dir = mkdtempSync(join(xdg !== undefined && existsSync(xdg) ? xdg : tmpdir(), "emr-"));
	chmodSync(dir, 0o700);
	return dir;
})();
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	rmSync(runtimeBase, { recursive: true, force: true });
});
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const d = join(base, `${name}-${made}`);
	mkdirSync(d, { recursive: true });
	return d;
};
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

const MODEL = "relay-model-1";
const policy = (change: Partial<EndoModelRelayPolicyV0> = {}): EndoModelRelayPolicyV0 => ({
	routes: ENDO_PI_MODEL_ROUTES_V0,
	model: MODEL,
	maxRequestBytes: 256 * 1024,
	maxTransferredBytes: 64 * 1024 * 1024,
	maxConnections: 8,
	maxTotalConnections: 256,
	maxExchanges: 256,
	maxCompletionTokens: 64,
	...change,
});
const judge = (p: EndoModelRelayPolicyV0, body: unknown) =>
	admitModelRequestV0(p, {
		method: "POST",
		path: "/v1/chat/completions",
		body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
	});
const chat = (extra: Record<string, unknown> = {}) => ({
	model: MODEL,
	stream: false,
	max_tokens: 16,
	messages: [{ role: "user", content: "Say hello" }],
	...extra,
});

describe("EVAL-ISO-003: the generation bound (refused, never rewritten)", () => {
	it("admits a request that states a bound within the policy's, in either field; refuses one that states none, more, or several choices", () => {
		const p = policy();
		expect(judge(p, chat())).toEqual({ admitted: true });
		const { max_tokens: _omit, ...unbounded } = chat();
		expect(judge(p, { ...unbounded, max_completion_tokens: 64 })).toEqual({ admitted: true });
		expect(judge(p, { ...unbounded, max_completion_tokens: 8, max_tokens: 8 })).toEqual({ admitted: true });
		expect(judge(p, { ...unbounded, n: 1, max_tokens: 1 })).toEqual({ admitted: true });
		expect(judge(p, { ...unbounded, n_predict: 64 })).toEqual({ admitted: true });
		expect(judge(p, chat({ n_predict: 16 }))).toEqual({ admitted: true });
		expect(judge(p, chat({ n_cmpl: 1 }))).toEqual({ admitted: true });
		for (const [name, body] of [
			["no bound at all", unbounded],
			["max_tokens over the bound", chat({ max_tokens: 65 })],
			["max_completion_tokens over the bound", { ...unbounded, max_completion_tokens: 1000 }],
			["one field within, the other over", chat({ max_completion_tokens: 65 })],
			["zero", chat({ max_tokens: 0 })],
			["negative", chat({ max_tokens: -1 })],
			["fractional", chat({ max_tokens: 1.5 })],
			["a string", chat({ max_tokens: "16" })],
			["null", chat({ max_tokens: null })],
			["several choices", chat({ n: 2 })],
			// llama.cpp reads n_predict before max_tokens: max_tokens 3 with n_predict -1 generated 311 tokens (b11429, measured).
			["an unbounded n_predict beside a bounded max_tokens", chat({ n_predict: -1 })],
			["n_predict over the bound", chat({ n_predict: 65 })],
			["n as a string", chat({ n: "1" })],
			// llama.cpp's own name for the choice count, with `n` only its fallback alias (b11429: tools/server/server-schema.cpp, `n_cmpl`,
			// limited to the server's slots): `{"n":1,"n_cmpl":4}` asks for four completions (Stage 0 review).
			["several completions by llama.cpp's n_cmpl", chat({ n_cmpl: 2 })],
			["n_cmpl beside n 1", chat({ n: 1, n_cmpl: 4 })],
			["n_cmpl as a string", chat({ n_cmpl: "1" })],
		] as const)
			expect(judge(p, body), name).toEqual({ admitted: false, reason: "generation" });
		// The route, the model and the body's shape are judged first, as before.
		expect(judge(p, chat({ model: "other" }))).toEqual({ admitted: false, reason: "model" });
	});

	it("a policy without the bound judges exactly as before (no field needed), and keeps its earlier digest", () => {
		const { maxCompletionTokens: _omit, ...earlier } = policy();
		const { max_tokens: _m, ...unbounded } = chat();
		expect(judge(earlier, unbounded)).toEqual({ admitted: true });
		// The digest of a policy without the field is computed over exactly the fields it had before EVAL-ISO-003.
		const expected = sha256HexV0(
			canonicalEndoJsonV0({
				routes: [{ method: "POST", path: "/v1/chat/completions" }],
				model: MODEL,
				maxRequestBytes: earlier.maxRequestBytes,
				maxTransferredBytes: earlier.maxTransferredBytes,
				maxConnections: earlier.maxConnections,
				maxTotalConnections: earlier.maxTotalConnections,
				maxExchanges: earlier.maxExchanges,
			}),
		);
		expect(modelRelayPolicyDigestV0(earlier)).toBe(expected);
		expect(modelRelayPolicyDigestV0(policy())).not.toBe(expected);
		expect(modelRelayPolicyDigestV0(policy({ maxCompletionTokens: 65 }))).not.toBe(
			modelRelayPolicyDigestV0(policy()),
		);
	});

	it("an unusable bound is refused when the relay starts", async () => {
		for (const bad of [0, -1, 1.5, 1_000_001])
			await expect(
				startModelRelayV0({
					upstream: "http://127.0.0.1:9",
					policy: policy({ maxCompletionTokens: bad }),
					log: new EndoCaptureLogV0(
						fresh("bad-store"),
						endoDigestKeyV0(randomBytes(32), "installation"),
						"record",
						{
							async: true,
						},
					),
					runtimeDirectory: runtimeBase,
				}),
			).rejects.toThrow(/maxCompletionTokens/);
	});
});

// ---- the version 1 spec ---------------------------------------------------------------------------------------------------------------------

const specV1 = (): Record<string, any> => ({
	schemaVersion: "endo.protected-experiment-spec.v1",
	id: "endo.experiment.model-test",
	description: "test",
	seed: 7,
	trials: 1,
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
	runtime: {
		executables: ["/usr/bin/node", "/usr/bin/bash"],
		aliases: [{ target: "/usr/bin/sh", executable: "/usr/bin/bash" }],
	},
	tasks: [
		{
			id: "merge-intervals",
			workspace: { "README.md": "task\n" },
			submission: ["src/interval.mjs"],
			evaluator: { file: "/nonexistent/evaluator.json", sha256: H("e") },
		},
	],
	conditions: [
		{
			id: "c",
			description: "c",
			agent: { directory: "/nonexistent/agent", argv: ["/usr/bin/node", "/agent/a.mjs"] },
		},
	],
	modelAccess: {
		upstream: "http://127.0.0.1:8081",
		model: "Muse-Glimmer-30B-Abliterated-Q4_K_M",
		routes: [{ method: "POST", path: "/v1/chat/completions" }],
		maxRequestBytes: 1024 * 1024,
		maxTransferredBytes: 256 * 1024 * 1024,
		maxConnections: 8,
		maxTotalConnections: 1024,
		maxExchanges: 64,
		maxCompletionTokens: 2048,
		minExchanges: 1,
	},
});

describe("EVAL-ISO-003: the version 1 spec declares the model access, and only it does", () => {
	it("reads a complete version 1 spec", () => {
		const read = readEndoProtectedSpecV0(specV1());
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.value.schemaVersion).toBe("endo.protected-experiment-spec.v1");
	});

	it("model access is opt-in by version: a version 0 spec cannot carry it, a version 1 spec cannot lack it", () => {
		const v1 = specV1();
		const asV0 = { ...clone(v1), schemaVersion: "endo.protected-experiment-spec.v0" };
		expect(readEndoProtectedSpecV0(asV0)).toMatchObject({
			ok: false,
			message: expect.stringMatching(/unknown field/),
		});
		const { modelAccess: _m, ...without } = clone(v1);
		expect(readEndoProtectedSpecV0(without)).toMatchObject({
			ok: false,
			message: expect.stringMatching(/missing field modelAccess/),
		});
	});

	it("refuses an upstream off this host's loopback, unbounded or contradictory bounds, and unsafe routes or aliases", () => {
		const variants: [string, (s: Record<string, any>) => void, RegExp][] = [
			[
				"a remote upstream",
				(s) => {
					s.modelAccess.upstream = "https://api.openai.com";
				},
				/upstream/,
			],
			[
				"localhost by name",
				(s) => {
					s.modelAccess.upstream = "http://localhost:8081";
				},
				/upstream/,
			],
			[
				"another loopback address",
				(s) => {
					s.modelAccess.upstream = "http://127.0.0.2:8081";
				},
				/upstream/,
			],
			[
				"a path on the upstream",
				(s) => {
					s.modelAccess.upstream = "http://127.0.0.1:8081/v1";
				},
				/upstream/,
			],
			[
				"port out of range",
				(s) => {
					s.modelAccess.upstream = "http://127.0.0.1:70000";
				},
				/port/,
			],
			["no generation bound", (s) => delete s.modelAccess.maxCompletionTokens, /maxCompletionTokens/],
			[
				"no minimum",
				(s) => {
					s.modelAccess.minExchanges = 0;
				},
				/minExchanges/,
			],
			[
				"minimum over the exchange bound",
				(s) => {
					s.modelAccess.minExchanges = 65;
				},
				/minExchanges/,
			],
			[
				"request bound over the governed proxy's",
				(s) => {
					s.modelAccess.maxRequestBytes = 2 * 1024 * 1024;
				},
				/maxRequestBytes/,
			],
			[
				"CONNECT",
				(s) => {
					s.modelAccess.routes = [{ method: "CONNECT", path: "/x" }];
				},
				/CONNECT/,
			],
			[
				"a query string",
				(s) => {
					s.modelAccess.routes = [{ method: "POST", path: "/v1/x?y=1" }];
				},
				/path/,
			],
			[
				"a dot segment",
				(s) => {
					s.modelAccess.routes = [{ method: "POST", path: "/v1/../models/load" }];
				},
				/path/,
			],
			[
				"a route twice",
				(s) => s.modelAccess.routes.push({ method: "POST", path: "/v1/chat/completions" }),
				/each once/,
			],
			[
				"no route",
				(s) => {
					s.modelAccess.routes = [];
				},
				/at least one route/,
			],
			["no memory limit", (s) => delete s.limits.memoryMaxBytes, /memoryMaxBytes/],
			[
				"a tiny memory limit",
				(s) => {
					s.limits.memoryMaxBytes = 1024;
				},
				/memoryMaxBytes/,
			],
			[
				"an alias of an undeclared executable",
				(s) => {
					s.runtime.aliases = [{ target: "/usr/bin/sh", executable: "/usr/bin/zsh" }];
				},
				/executables/,
			],
			[
				"an alias over the workspace",
				(s) => {
					s.runtime.aliases = [{ target: "/work/sh", executable: "/usr/bin/bash" }];
				},
				/reserves/,
			],
			[
				"an alias over the relay",
				(s) => {
					s.runtime.aliases = [{ target: "/run/endo/model.sock", executable: "/usr/bin/bash" }];
				},
				/reserves/,
			],
			[
				"an alias at an executable's own path",
				(s) => {
					s.runtime.aliases = [{ target: "/usr/bin/node", executable: "/usr/bin/bash" }];
				},
				/each target once/,
			],
			[
				"an extra field",
				(s) => {
					s.modelAccess.temperature = 0;
				},
				/unknown field/,
			],
		];
		for (const [name, change, why] of variants) {
			const s = specV1();
			change(s);
			expect(readEndoProtectedSpecV0(s), name).toMatchObject({ ok: false, message: expect.stringMatching(why) });
		}
	});

	it("a run record's version fixes its spec's: a version 1 run over a version 0 spec (or the reverse) is refused", () => {
		const v1 = specV1();
		const run = (schemaVersion: string, spec: unknown) =>
			readEndoProtectedRunV0({
				schemaVersion,
				runner: "r",
				spec,
				specSha256: H("1"),
				seed: 7,
				seedSource: "spec",
				ordering: "o",
				plan: [{ position: 0, task: "merge-intervals", condition: "c", trial: 0 }],
				isolation: {
					mechanism: "bubblewrap",
					version: "0.13.1",
					executableSha256: H("2"),
					containment: {
						mechanism: "systemd-user-scope",
						version: "262",
						systemdRunSha256: H("9"),
						tasksMax: 512,
					},
				},
				profiles: [{ condition: "c", sha256: H("3") }],
				evaluators: [
					{
						task: "merge-intervals",
						definitionSha256: H("e"),
						driverSha256: H("7"),
						reference: "passed",
						negative: null,
					},
				],
				createdAt: "2026-11-09T00:00:00.000Z",
			});
		expect(run("endo.protected-run.v1", v1).ok).toBe(true);
		const { modelAccess: _m, ...v0 } = clone(v1);
		v0.schemaVersion = "endo.protected-experiment-spec.v0";
		v0.limits = { ...v0.limits };
		delete v0.limits.memoryMaxBytes;
		delete v0.limits.cpuQuotaPercent;
		v0.runtime = { executables: v0.runtime.executables };
		expect(run("endo.protected-run.v0", v0).ok).toBe(true);
		expect(run("endo.protected-run.v1", v0)).toMatchObject({
			ok: false,
			message: expect.stringMatching(/missing field modelAccess/),
		});
		// With every field a version 1 spec has, a spec still declaring version 0 is not read as version 1.
		expect(
			run("endo.protected-run.v1", { ...clone(v1), schemaVersion: "endo.protected-experiment-spec.v0" }),
		).toMatchObject({
			ok: false,
			message: expect.stringMatching(/schemaVersion is not endo\.protected-experiment-spec\.v1/),
		});
		expect(run("endo.protected-run.v0", v1)).toMatchObject({
			ok: false,
			message: expect.stringMatching(/schemaVersion|unknown field/),
		});
	});
});

// ---- the version 1 trial record ----------------------------------------------------------------------------------------------------------

const exchange = (n: number, change: Partial<EndoProtectedTrialV1["recording"]["exchanges"][number]> = {}) => ({
	exchange: n,
	method: "POST",
	path: "/v1/chat/completions",
	requestSha256: H(String(n % 10)),
	status: 200,
	class: "answered" as const,
	verified: true,
	...change,
});

/** A complete, consistent version 1 record of a passed attempt with one successful model exchange, unsealed. */
function passedV1(): Omit<EndoProtectedTrialV1, "recordSha256"> {
	const files = [{ path: "src/a.mjs", bytes: 3, sha256: H("a") }];
	return {
		schemaVersion: "endo.protected-trial.v1",
		run: { id: "endo.experiment.t", specSha256: H("1"), seed: 1 },
		trial: { position: 0, task: "t", condition: "c", trial: 0, attempt: 1, retryOf: null },
		isolation: {
			mechanism: "bubblewrap",
			version: "0.13.1",
			executableSha256: H("2"),
			containment: { mechanism: "systemd-user-scope", version: "262", systemdRunSha256: H("9"), tasksMax: 512 },
			profileSha256: H("3"),
			requested: {
				namespaces: ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"],
				network: "model-relay",
				rootReadOnly: true,
				userNamespacesDisabled: true,
				environment: ["ENDO_MODEL_ID", "HOME", "PATH", "TMPDIR"],
				mounts: [
					{ target: "/run/endo/bridge.cjs", kind: "ro-file", role: "model-bridge", sha256: H("b") },
					{ target: "/run/endo/model.sock", kind: "socket", role: "model-relay", sha256: null },
					{ target: "/usr/bin/node", kind: "ro-file", role: "runtime", sha256: H("4") },
					{ target: "/work", kind: "rw-dir", role: "workspace", sha256: null },
				],
			},
			limits: { memoryMaxBytes: 512 * 1024 * 1024, cpuQuotaPercent: 200 },
		},
		preflight: {
			status: "established",
			probes: [{ id: "net-model-relay", passed: true, observed: "connected" }],
			reason: null,
		},
		network: {
			mode: "model-relay",
			relay: {
				policySha256: H("c"),
				status: "ran",
				admitted: 1,
				refusals: {
					route: 0,
					size: 0,
					body: 0,
					model: 0,
					generation: 0,
					unjudged: 0,
					connections: 0,
					exchanges: 0,
				},
				transferredBytes: 1000,
				recordingFailures: 0,
			},
			status: "established",
		},
		agent: {
			status: "completed",
			exitCode: 0,
			signal: null,
			durationMs: 10,
			termination: "confirmed",
			outputSha256: H("5"),
			scope: { unit: `endo-sandbox-${"a".repeat(24)}`, established: true, ended: "confirmed", result: null },
		},
		submission: { status: "collected", files, sha256: endoSubmissionDigestV0(files), refusals: [] },
		evaluation: {
			status: "passed",
			definitionSha256: H("6"),
			driverSha256: H("7"),
			cases: { total: 3, passed: 3 },
			reason: null,
			outputSha256: H("8"),
		},
		controller: { finalized: "normally" },
		recording: { status: "complete", keyId: "installation:abc", required: 1, exchanges: [exchange(1)] },
		invalidating: [],
		recordedAt: "2026-11-09T00:00:00.000Z",
	};
}
const seal = (r: Omit<EndoProtectedTrialV1, "recordSha256">) => sealEndoProtectedTrialV0<EndoProtectedTrialV1>(r);
const reads = (r: unknown) => checkEndoProtectedTrialV0(r);

describe("EVAL-ISO-003: the version 1 trial record and its reader", () => {
	it("a consistent model-connected record seals, reads back, and passes", () => {
		const sealed = seal(passedV1());
		expect(reads(clone(sealed)).ok).toBe(true);
		expect(endoProtectedTrialOutcomeV0(sealed)).toEqual({ outcome: "passed", reason: null });
	});

	it("version 0 and version 1 are never read as each other", () => {
		const sealed = seal(passedV1());
		// A version 1 record relabelled version 0: it names a relay, which version 0 refuses.
		expect(reads({ ...clone(sealed), schemaVersion: "endo.protected-trial.v0" }).ok).toBe(false);
		// A version 0 record (offline) relabelled version 1: no recording, no relay.
		const v0: Record<string, any> = clone(sealed);
		delete v0.recording;
		delete v0.isolation.limits;
		v0.network = { mode: "none", relay: null, status: "established" };
		v0.isolation.requested.network = "none";
		v0.isolation.requested.mounts = v0.isolation.requested.mounts.filter(
			(m: { kind: string }) => m.kind !== "socket",
		);
		delete v0.agent.scope.result;
		v0.schemaVersion = "endo.protected-trial.v0";
		const asV0 = sealEndoProtectedTrialV0<EndoProtectedTrialV0>(v0 as Omit<EndoProtectedTrialV0, "recordSha256">);
		expect(reads(clone(asV0)).ok).toBe(true);
		expect(reads({ ...clone(asV0), schemaVersion: "endo.protected-trial.v1" }).ok).toBe(false);
	});

	it("too few successful model exchanges is a judged failure whatever the evaluator found, never a pass and never attrition", () => {
		const none = passedV1();
		none.recording.exchanges = [];
		none.network.relay.admitted = 0;
		expect(endoProtectedTrialOutcomeV0(seal(none))).toEqual({
			outcome: "failed",
			reason: "model-exchanges-below-minimum",
		});
		// Exchanges that were not successful do not count: a refusal, a non-2xx answer, an unverified one.
		const unsuccessful = passedV1();
		unsuccessful.recording.exchanges = [
			exchange(1, { class: "refused", status: null }),
			exchange(2, { status: 503 }),
			exchange(3, { class: "client-disconnected", status: 200 }),
		];
		unsuccessful.network.relay.admitted = 2;
		unsuccessful.network.relay.refusals!.route = 1;
		expect(endoProtectedTrialOutcomeV0(seal(unsuccessful))).toEqual({
			outcome: "failed",
			reason: "model-exchanges-below-minimum",
		});
		// The minimum is the record's own: two required, one successful.
		const two = passedV1();
		two.recording.required = 2;
		expect(endoProtectedTrialOutcomeV0(seal(two)).reason).toBe("model-exchanges-below-minimum");
		expect(successfulExchangeV0(exchange(1))).toBe(true);
		expect(successfulExchangeV0(exchange(1, { verified: false }))).toBe(false);
	});

	it("a refused request is the agent's doing; a model server's failure, a failed relay or an incomplete recording is attrition", () => {
		const refused = passedV1();
		refused.recording.exchanges = [exchange(1, { class: "refused", status: null }), exchange(2)];
		refused.network.relay.refusals!.model = 1;
		expect(endoProtectedTrialOutcomeV0(seal(refused))).toEqual({ outcome: "passed", reason: null });

		const failed = passedV1();
		failed.recording.exchanges = [exchange(1, { class: "model-failed", status: null }), exchange(2)];
		failed.network.relay.admitted = 2;
		failed.invalidating = ["model-upstream-error"];
		expect(endoProtectedTrialOutcomeV0(seal(failed))).toEqual({
			outcome: "attrition",
			reason: "model-upstream-error",
		});

		const incomplete = passedV1();
		incomplete.network.relay.recordingFailures = 1;
		incomplete.recording.status = "incomplete";
		incomplete.invalidating = ["recording-incomplete"];
		expect(endoProtectedTrialOutcomeV0(seal(incomplete))).toEqual({
			outcome: "attrition",
			reason: "recording-incomplete",
		});

		const noRelay = passedV1();
		noRelay.network.relay = {
			policySha256: H("c"),
			status: "failed-to-start",
			admitted: null,
			refusals: null,
			transferredBytes: null,
			recordingFailures: null,
		};
		noRelay.recording = { status: "none", keyId: null, required: 1, exchanges: [] };
		noRelay.agent = {
			status: "not-run",
			exitCode: null,
			signal: null,
			durationMs: null,
			termination: "not-applicable",
			outputSha256: null,
			scope: null,
		};
		noRelay.submission = { status: "not-collected", files: [], sha256: null, refusals: [] };
		noRelay.evaluation = { ...noRelay.evaluation, status: "not-run", cases: null, outputSha256: null };
		noRelay.invalidating = ["relay-unavailable"];
		expect(endoProtectedTrialOutcomeV0(seal(noRelay))).toEqual({ outcome: "attrition", reason: "relay-unavailable" });

		// The controller's fallback when a summary would not make a consistent record: attrition, claiming no exchange.
		const inconsistent = passedV1();
		inconsistent.recording = { ...inconsistent.recording, status: "inconsistent", exchanges: [] };
		inconsistent.invalidating = ["recording-inconsistent"];
		expect(endoProtectedTrialOutcomeV0(seal(inconsistent))).toEqual({
			outcome: "attrition",
			reason: "recording-inconsistent",
		});
	});

	it("refuses a syntactically valid record whose model facts contradict each other", () => {
		const cases: [string, (r: ReturnType<typeof passedV1>) => void, RegExp][] = [
			[
				"an omitted invalidating condition",
				(r) => {
					r.recording.exchanges = [exchange(1, { class: "model-failed", status: null })];
				},
				/invalidating/,
			],
			[
				"an invented one",
				(r) => {
					r.invalidating = ["recording-incomplete"];
				},
				/invalidating/,
			],
			[
				"complete, but a capture write failed",
				(r) => {
					r.network.relay.recordingFailures = 1;
				},
				/complete exactly/,
			],
			[
				"complete, but an exchange does not verify",
				(r) => {
					r.recording.exchanges = [exchange(1, { verified: false })];
				},
				/complete exactly/,
			],
			[
				"complete, but an exchange has no end",
				(r) => {
					r.recording.exchanges = [exchange(1, { class: "unended", status: null })];
				},
				/complete exactly/,
			],
			[
				"complete, without a digest domain",
				(r) => {
					r.recording.keyId = null;
					r.recording.exchanges = [];
					r.network.relay.admitted = 0;
				},
				/complete exactly|domain/,
			],
			[
				"incomplete, though whole",
				(r) => {
					r.recording.status = "incomplete";
					r.invalidating = ["recording-incomplete"];
				},
				/complete exactly/,
			],
			[
				"more admitted than possibly forwarded",
				(r) => {
					r.network.relay.admitted = 2;
				},
				/admitted/,
			],
			[
				"fewer admitted than forwarded",
				(r) => {
					r.network.relay.admitted = 0;
				},
				/admitted/,
			],
			[
				"exchanges with a gap",
				(r) => {
					r.recording.exchanges = [exchange(2)];
				},
				/without gaps/,
			],
			[
				"an answer without a status",
				(r) => {
					r.recording.exchanges = [exchange(1, { status: null })];
				},
				/status/,
			],
			[
				"a refusal with a status",
				(r) => {
					r.recording.exchanges = [exchange(1, { class: "refused", status: 200 })];
				},
				/status/,
			],
			[
				"an agent that ran without its relay",
				(r) => {
					r.network.relay = {
						...r.network.relay,
						status: "not-started",
						admitted: null,
						refusals: null,
						transferredBytes: null,
						recordingFailures: null,
					};
					r.recording = { status: "none", keyId: null, required: 1, exchanges: [] };
				},
				/without its relay/,
			],
			[
				"a relay neither started nor failed after an established boundary",
				(r) => {
					r.network.relay = {
						...r.network.relay,
						status: "not-started",
						admitted: null,
						refusals: null,
						transferredBytes: null,
						recordingFailures: null,
					};
					r.recording = { status: "none", keyId: null, required: 1, exchanges: [] };
					r.agent = {
						status: "not-run",
						exitCode: null,
						signal: null,
						durationMs: null,
						termination: "not-applicable",
						outputSha256: null,
						scope: null,
					};
					r.submission = { status: "not-collected", files: [], sha256: null, refusals: [] };
					r.evaluation = { ...r.evaluation, status: "not-run", cases: null, outputSha256: null };
				},
				/finalized on resume/,
			],
			[
				"an inconsistent recording that claims exchanges",
				(r) => {
					r.recording.status = "inconsistent";
					r.invalidating = ["recording-inconsistent"];
				},
				/claims no exchange/,
			],
			[
				"relay counters it could not have",
				(r) => {
					r.network.relay.status = "interrupted";
				},
				/counters/,
			],
			[
				"an unknown recording in a normally finalized attempt",
				(r) => {
					r.network.relay = {
						...r.network.relay,
						status: "interrupted",
						admitted: null,
						refusals: null,
						transferredBytes: null,
						recordingFailures: null,
					};
					r.recording.status = "unknown";
				},
				/interrupted only/,
			],
			[
				"no socket mounted",
				(r) => {
					r.isolation.requested.mounts = r.isolation.requested.mounts.filter((m) => m.kind !== "socket");
				},
				/socket/,
			],
			[
				"two sockets",
				(r) =>
					r.isolation.requested.mounts.push({
						target: "/run/endo/other.sock",
						kind: "socket",
						role: "model-relay",
						sha256: null,
					}),
				/socket/,
			],
			[
				"an offline network",
				(r) => {
					(r.network as { mode: string }).mode = "none";
				},
				/network\.mode/,
			],
			["no scope result field", (r) => delete (r.agent.scope as { result?: unknown }).result, /result/],
			[
				"a minimum of zero",
				(r) => {
					r.recording.required = 0;
				},
				/required/,
			],
			[
				"an unknown refusal reason",
				(r) => {
					(r.network.relay.refusals as Record<string, number>).other = 1;
				},
				/unknown field/,
			],
		];
		for (const [name, change, why] of cases) {
			const r = passedV1();
			change(r);
			expect(() => seal(r), name).toThrow(why);
		}
	});
});

// ---- the evidence, against a real relay's recording ---------------------------------------------------------------------------------------

/** One HTTP exchange over the relay's socket, on a new connection. */
function overSocket(relay: EndoModelRelayV0, path: string, body?: string, method = "POST") {
	return new Promise<{ status: number } | { closed: string }>((resolve) => {
		const req = httpRequest(
			{
				socketPath: relay.socketPath,
				agent: false,
				method,
				path,
				headers:
					body === undefined
						? {}
						: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
				res.on("error", (e) => resolve({ closed: (e as NodeJS.ErrnoException).code ?? "error" }));
			},
		);
		req.on("error", (e) => resolve({ closed: (e as NodeJS.ErrnoException).code ?? "error" }));
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/** Two requests written at once on one connection (pipelined): the first refused, the second admissible on its own. */
function pipelined(relay: EndoModelRelayV0, first: string, second: string): Promise<void> {
	const { connect } = require("node:net") as typeof import("node:net");
	const head = (b: string) =>
		`POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(b)}\r\n\r\n${b}`;
	return new Promise((resolve) => {
		const s = connect(relay.socketPath, () => s.write(head(first) + head(second)));
		s.on("data", () => {});
		s.on("error", () => resolve());
		s.on("close", () => resolve());
	});
}

async function recorded(upstreamOptions = {}, change: Partial<EndoModelRelayPolicyV0> = {}, origin?: string) {
	const upstream: FakeOpenAiServer = await startFakeOpenAiServer(upstreamOptions);
	const keyBytes = randomBytes(32);
	const key = endoDigestKeyV0(keyBytes, "installation");
	const store = fresh("store");
	const log = new EndoCaptureLogV0(store, key, "record", { async: true });
	const p = policy(change);
	const relay = await startModelRelayV0({
		upstream: origin ?? new URL(upstream.baseUrl).origin,
		policy: p,
		log,
		runtimeDirectory: runtimeBase,
	});
	cleanup.push(async () => {
		await relay.close();
		log.close();
		await upstream.close();
	});
	const finish = async () => {
		await relay.close();
		log.close();
		return { summary: summarizeModelRecordingV0(store, key), admitted: relay.admitted(), refusals: relay.refusals() };
	};
	return { upstream, relay, store, key, policy: p, finish };
}

describe("EVAL-ISO-003: the recording, read again by the independent reader", () => {
	it("classifies each exchange from the recording itself: answered, refused (the judge's and what was pipelined behind it), client-disconnected", async () => {
		const r = await recorded();
		expect(await overSocket(r.relay, "/v1/chat/completions", JSON.stringify(chat()))).toEqual({ status: 200 });
		expect(
			await overSocket(r.relay, "/v1/chat/completions", JSON.stringify(chat({ max_tokens: 1000 }))),
		).toHaveProperty("closed");
		await pipelined(r.relay, JSON.stringify(chat({ model: "other" })), JSON.stringify(chat()));
		const { summary, admitted, refusals } = await r.finish();
		expect(summary.exchanges.map((e) => e.class)).toEqual(["answered", "refused", "refused", "refused"]);
		expect(summary.exchanges.every((e) => e.verified)).toBe(true);
		expect(admitted).toBe(1);
		expect(refusals).toMatchObject({ generation: 1, model: 1 });
		// The model server saw only the admitted request.
		expect(r.upstream.completionRequests()).toHaveLength(1);
		expect(
			verifyModelEvidenceV0({ store: r.store, key: r.key, policy: r.policy, recorded: summary, admitted }),
		).toBeNull();
		// The pipelined second request is admissible on its own, which is why refused exchanges are not judged again.
		expect(exchangesOutsidePolicyV0(r.store, r.key, r.policy).map((o) => o.exchange)).toEqual([2, 3]);
	});

	it("a forwarded request the model server failed is model-failed, not a refusal", async () => {
		const r = await recorded();
		await r.upstream.close();
		expect(await overSocket(r.relay, "/v1/chat/completions", JSON.stringify(chat()))).toHaveProperty("closed");
		const { summary, admitted } = await r.finish();
		expect(summary.exchanges.map((e) => e.class)).toEqual(["model-failed"]);
		expect(admitted).toBe(1);
		expect(
			verifyModelEvidenceV0({ store: r.store, key: r.key, policy: r.policy, recorded: summary, admitted }),
		).toBeNull();
	});

	it("a response the relay's own transfer bound cuts is transfer-bound, the agent's traffic: never a model failure, never attrition (Stage 0 review)", async () => {
		// The bound is reached mid-response: the relay destroys every connection (countTransfer). The model server did not fail.
		const r = await recorded({ slowChunkMs: 20 }, { maxTransferredBytes: 3000 });
		const body = JSON.stringify(chat({ stream: true, messages: [{ role: "user", content: "count to forty" }] }));
		expect(await overSocket(r.relay, "/v1/chat/completions", body)).toHaveProperty("closed");
		const { summary, admitted } = await r.finish();
		expect(r.relay.transferredBytes()).toBeGreaterThan(3000);
		expect(summary.exchanges.map((e) => [e.class, e.status, e.verified])).toEqual([["transfer-bound", 200, true]]);
		expect(admitted).toBe(1);
		expect(
			verifyModelEvidenceV0({ store: r.store, key: r.key, policy: r.policy, recorded: summary, admitted }),
		).toBeNull();
		// As a record: not invalidating and not successful, so the trial is judged (here, too few successful exchanges).
		const record = passedV1();
		record.recording.exchanges = summary.exchanges;
		record.network.relay.admitted = 1;
		const sealed = seal(record);
		expect(sealed.invalidating).toEqual([]);
		expect(endoProtectedTrialOutcomeV0(sealed)).toEqual({
			outcome: "failed",
			reason: "model-exchanges-below-minimum",
		});
	});

	it("closing the relay while a response is still streaming records that exchange's end, on disk, before close() resolves", async () => {
		const r = await recorded({ slowChunkMs: 1000 });
		const body = JSON.stringify(chat({ stream: true, messages: [{ role: "user", content: "count to forty" }] }));
		const streaming = new Promise<void>((resolve) => {
			const req = httpRequest(
				{
					socketPath: r.relay.socketPath,
					agent: false,
					method: "POST",
					path: "/v1/chat/completions",
					headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
				},
				(res) => res.once("data", () => resolve()),
			);
			req.on("error", () => {});
			req.end(body);
		});
		await streaming;
		// Well into the stream (the earlier close() lost the end of any response streaming for 300 ms or more).
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const { summary, admitted } = await r.finish();
		expect(summary.exchanges.map((e) => [e.class, e.verified])).toEqual([["client-disconnected", true]]);
		expect(
			verifyModelEvidenceV0({ store: r.store, key: r.key, policy: r.policy, recorded: summary, admitted }),
		).toBeNull();
	});

	it("whatever an agent writes on its connection, the recording makes a record that seals and that the reader accepts (review, EVAL-ISO-003)", async () => {
		const { connect } = await import("node:net");
		const body = JSON.stringify(chat());
		const post = `POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
		const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
		const scenarios: [string, (send: (bytes: string) => void) => Promise<void>][] = [
			// Two requests pipelined, then the connection dropped: the second was queued, never judged, never forwarded.
			[
				"pipelined, then dropped",
				async (send) => {
					send(post + post);
					await pause(30);
				},
			],
			// Junk after a forwarded request: the governed refusal must not relabel the forwarded one a refusal.
			[
				"junk after a forwarded request",
				async (send) => {
					send(post);
					await pause(20);
					send("\x16\x03\x01junk\r\n\r\n");
					await pause(300);
				},
			],
			// A method token the recording must keep as it is, and a 9000-byte target: both refused by the judge (route).
			[
				"an unusual method",
				async (send) => {
					send("M-SEARCH /v1/chat/completions HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\n\r\n");
					await pause(200);
				},
			],
			[
				"a very long target",
				async (send) => {
					send(`POST /${"a".repeat(9000)} HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\n\r\n`);
					await pause(200);
				},
			],
		];
		// A model server that holds its answer back 300 ms: a request can be forwarded and still unanswered when the agent drops it.
		const { createServer } = await import("node:net");
		const slow = createServer((socket) => {
			let seen = "";
			socket.on("error", () => {});
			socket.on("data", (d) => {
				seen += d.toString();
				if (!seen.includes("\r\n\r\n")) return;
				seen = "";
				const answer = '{"choices":[]}';
				setTimeout(() => {
					if (!socket.destroyed)
						socket.write(
							`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${answer.length}\r\n\r\n${answer}`,
						);
				}, 300);
			});
		});
		await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", () => resolve()));
		cleanup.push(() => new Promise<void>((resolve) => slow.close(() => resolve())));
		const slowOrigin = `http://127.0.0.1:${(slow.address() as { port: number }).port}`;
		for (const [name, act] of scenarios) {
			const r = await recorded({}, {}, slowOrigin);
			const socket = connect(r.relay.socketPath);
			socket.on("error", () => {});
			await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
			await act((bytes) => socket.write(bytes));
			socket.destroy();
			await pause(100);
			const { summary, admitted, refusals } = await r.finish();
			const record = passedV1();
			record.network.relay = { ...record.network.relay, admitted, refusals: { ...refusals } };
			record.recording = { status: "complete", keyId: summary.keyId, required: 1, exchanges: summary.exchanges };
			record.invalidating = summary.exchanges.some((e) => e.class === "model-failed")
				? ["model-upstream-error"]
				: [];
			expect(() => seal(record), name).not.toThrow();
			expect(
				verifyModelEvidenceV0({ store: r.store, key: r.key, policy: r.policy, recorded: summary, admitted }),
				name,
			).toBeNull();
			await r.upstream.close();
		}
	});

	it("refuses a record whose exchanges, counts, policy, key or bodies do not match the recording", async () => {
		const r = await recorded();
		for (let i = 0; i < 2; i++) await overSocket(r.relay, "/v1/chat/completions", JSON.stringify(chat()));
		const { summary, admitted } = await r.finish();
		const check = (change: Partial<Parameters<typeof verifyModelEvidenceV0>[0]>) =>
			verifyModelEvidenceV0({
				store: r.store,
				key: r.key,
				policy: r.policy,
				recorded: summary,
				admitted,
				...change,
			});
		expect(check({})).toBeNull();
		// The record claims a different exchange list: one dropped, one relabelled, one re-statused.
		expect(check({ recorded: { ...summary, exchanges: summary.exchanges.slice(0, 1) } })).toMatch(/not the ones/);
		expect(
			check({
				recorded: { ...summary, exchanges: summary.exchanges.map((e) => ({ ...e, class: "refused" as const })) },
			}),
		).toMatch(/not the ones/);
		expect(
			check({ recorded: { ...summary, exchanges: summary.exchanges.map((e) => ({ ...e, status: 201 })) } }),
		).toMatch(/not the ones/);
		// The relay's count disagrees with what the recording shows forwarded.
		expect(check({ admitted: 3 })).toMatch(/admitted 3/);
		expect(check({ admitted: 1 })).toMatch(/admitted 1 request\(s\), the recording shows 2 forwarded/);
		// The declared policy refuses what was forwarded (another model, a tighter generation bound, a lower exchange bound).
		expect(check({ policy: policy({ model: "other" }) })).toMatch(/refuses: 1 \(model\), 2 \(model\)/);
		expect(check({ policy: policy({ maxCompletionTokens: 8 }) })).toMatch(/generation/);
		expect(check({ policy: policy({ maxExchanges: 1 }) })).toMatch(/exchange bound/);
		// Another attempt's key (another digest domain), or the record naming another.
		expect(check({ key: endoDigestKeyV0(randomBytes(32), "installation") })).toMatch(/does not load|domain/);
		expect(check({ recorded: { ...summary, keyId: "installation:other" } })).toMatch(/digest domain/);
		// A recorded body altered on disk no longer verifies, so the derived summary differs from the record's.
		const blobs = join(r.store, "capture", "blobs");
		const walk = (d: string): string[] =>
			readdirSync(d, { withFileTypes: true }).flatMap((e) =>
				e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
			);
		const files = existsSync(blobs)
			? walk(blobs)
			: walk(join(r.store, "capture")).filter((f) => !f.endsWith(".jsonl"));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) writeFileSync(f, "altered");
		expect(check({})).not.toBeNull();
	});
});
