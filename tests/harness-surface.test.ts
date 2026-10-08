// The effective harness surface (protocol/harness-surface.ts, adapters/openai-proxy/harness-surface.ts), derived from
// real capture logs: requests are recorded with the capture log's own writer (events plus keyed blobs) and read back
// from the store, as an experiment's trial is.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENDO_CAPTURE_VERSION_V0, EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import {
	deriveEndoHarnessSurfaceV0,
	harnessSurfacesOfCaptureV0,
	requestParametersOfEndoHarnessSurfaceV0,
} from "../adapters/openai-proxy/harness-surface.ts";
import { endoRequestDigestV0 } from "../adapters/openai-proxy/http.ts";
import { surfaceLine } from "../cli/experiment.ts";
import {
	buildEndoTrialHarnessV0,
	requestParameterObservationsOfTrialV0,
	requestParametersOfTrialV0,
	samplingOfParameters,
	summarizeEndoCellHarnessSurfacesV0,
} from "../cli/experiment-surface.ts";
import {
	ENDO_EXPERIMENT_TRIAL_SURFACE_VERSIONS_V1,
	type EndoExperimentTrialResultAnyV0,
	type EndoExperimentTrialResultV1,
	readEndoExperimentTrialResultV0,
} from "../protocol/experiment-artifacts.ts";
import {
	compareEndoHarnessSurfacesV0,
	ENDO_HARNESS_SURFACE_KEY_ID_PATTERN_V0,
	ENDO_HARNESS_SURFACE_VERSIONS_V0,
	type EndoHarnessSurfaceComponentsV0,
	type EndoHarnessSurfaceV0,
	endoHarnessSurfaceIdentityBasisV0,
} from "../protocol/harness-surface.ts";
import { readEndoVersionedV0 } from "../protocol/versioned.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { ENDO_DIGEST_KEY_ID_PATTERN_V0 } from "../runtime/contracts/keyed-digest.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";

const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
const altKey = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0("fixture-public-alt"));

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Body = Record<string, unknown> | string;

const readTool = {
	type: "function",
	function: { name: "read", description: "Read a file", parameters: { type: "object" } },
};
const bashTool = {
	type: "function",
	function: { name: "bash", description: "Run a command", parameters: { type: "object" } },
};

/** A chat request: the harness-facing parts (system, tools, parameters) fixed unless overridden, the task varying. */
function chat(overrides: Record<string, unknown> = {}, task = "fix the failing test"): Record<string, unknown> {
	return {
		model: "model-a",
		stream: true,
		messages: [
			{ role: "system", content: "You are a coding agent.\nCurrent working directory: /work" },
			{ role: "user", content: task },
		],
		tools: [readTool, bashTool],
		max_tokens: 4096,
		...overrides,
	};
}

/** Record `requests` with the capture log's writer, return the store root. */
function record(
	requests: { body: Body; method?: string; path?: string }[],
	options: { key?: typeof key; version?: string | null } = {},
): string {
	const store = mkdtempSync(join(tmpdir(), "endo-surface-"));
	dirs.push(store);
	const k = options.key ?? key;
	const log = new EndoCaptureLogV0(store, k, "record");
	if (options.version !== null)
		log.record("capture.started", {
			role: "record",
			capture: options.version ?? ENDO_CAPTURE_VERSION_V0,
			listen: "http://127.0.0.1:1",
			upstream: "http://127.0.0.1:2",
			digestKey: { keyId: k.keyId, domain: k.domain },
		});
	for (const [index, request] of requests.entries()) {
		const method = request.method ?? "POST";
		const path = request.path ?? "/v1/chat/completions";
		const body = Buffer.from(typeof request.body === "string" ? request.body : JSON.stringify(request.body));
		log.record("capture.request", {
			exchange: index + 1,
			attempt: 1,
			method,
			path,
			requestDigest: { ...endoRequestDigestV0(k, method, path, body) },
			body: { ...log.keep(body) } as never,
			headers: [],
			offsetMs: 0,
		});
	}
	log.close();
	return store;
}

const surfaceOf = (body: Body, k = key, extra: { method?: string; path?: string } = {}): EndoHarnessSurfaceV0 =>
	harnessSurfacesOfCaptureV0(record([{ body, ...extra }], { key: k }), k)[0]!;

const componentsOf = (surface: EndoHarnessSurfaceV0): EndoHarnessSurfaceComponentsV0 => {
	if (surface.components.status !== "reported") throw new Error(`unrecognized: ${surface.dialect.status}`);
	return surface.components.value;
};

const identityOf = (body: Body, k = key) => componentsOf(surfaceOf(body, k)).identity;

describe("the harness surface is derived from the recorded wire", () => {
	it("records source, dialect, model, instructions, tools and parameters of a chat request", () => {
		const surface = surfaceOf(chat({ temperature: 0.2, tool_choice: "auto" }));
		expect(readEndoVersionedV0(ENDO_HARNESS_SURFACE_VERSIONS_V0, surface).ok).toBe(true);
		expect(surface.source).toMatchObject({
			captureVersion: ENDO_CAPTURE_VERSION_V0,
			exchange: 1,
			method: "POST",
			path: "/v1/chat/completions",
		});
		expect(surface.digestKey).toEqual({ algorithm: "hmac-sha256", keyId: key.keyId });
		expect(surface.dialect).toEqual({ status: "reported", value: "openai.chat-completions" });
		const c = componentsOf(surface);
		expect(c.model).toEqual({ status: "reported", value: "model-a" });
		expect(c.streaming).toEqual({ status: "reported", value: true });
		expect(c.instructions.items).toMatchObject([{ position: 0, role: "system" }]);
		expect(c.tools).toMatchObject({ present: true, count: 2, items: [{ name: "read" }, { name: "bash" }] });
		expect(Object.keys(c.parameters.fields).sort()).toEqual(["max_tokens", "temperature", "tool_choice"]);
		expect(c.parameters.fields.temperature?.value).toBe(0.2);
	});

	it("the source names the capture version the log declared, or null when it declared none", () => {
		const old = harnessSurfacesOfCaptureV0(record([{ body: chat() }], { version: "endo-capture.1" }), key)[0]!;
		expect(old.source.captureVersion).toBe("endo-capture.1");
		const none = harnessSurfacesOfCaptureV0(record([{ body: chat() }], { version: null }), key)[0]!;
		expect(none.source.captureVersion).toBeNull();
	});

	it("1. the same model-facing surface with a different user prompt, history and tool result has the same identity", () => {
		const a = identityOf(chat({}, "fix the failing test"));
		const b = identityOf(chat({}, "write a haiku about rust"));
		const longer = identityOf(
			chat({
				messages: [
					{ role: "system", content: "You are a coding agent.\nCurrent working directory: /work" },
					{ role: "user", content: "something else entirely" },
					{
						role: "assistant",
						content: "ok",
						tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }],
					},
					{ role: "tool", tool_call_id: "1", content: "file contents" },
					{ role: "user", content: "and then?" },
				],
			}),
		);
		expect(b).toBe(a);
		expect(longer).toBe(a);
	});

	it("2. a changed system instruction changes the identity; 3. so does a developer instruction", () => {
		const base = identityOf(chat());
		const system = chat({
			messages: [
				{ role: "system", content: "You are a coding agent.\nCurrent working directory: /other" },
				{ role: "user", content: "fix the failing test" },
			],
		});
		expect(identityOf(system)).not.toBe(base);
		const dev = (text: string) =>
			chat({
				messages: [
					{ role: "system", content: "You are a coding agent.\nCurrent working directory: /work" },
					{ role: "developer", content: text },
					{ role: "user", content: "fix the failing test" },
				],
			});
		expect(identityOf(dev("be terse"))).not.toBe(base);
		expect(identityOf(dev("be verbose"))).not.toBe(identityOf(dev("be terse")));
		expect(componentsOf(surfaceOf(dev("be terse"))).instructions.items.map((i) => [i.role, i.position])).toEqual([
			["system", 0],
			["developer", 1],
		]);
	});

	it("4. a changed tool schema differs; 5. the same tools in another order differ only in order", () => {
		const base = surfaceOf(chat());
		const edited = surfaceOf(
			chat({
				tools: [readTool, { ...bashTool, function: { ...bashTool.function, description: "Run a shell command" } }],
			}),
		);
		const reordered = surfaceOf(chat({ tools: [bashTool, readTool] }));
		expect(componentsOf(edited).identity).not.toBe(componentsOf(base).identity);
		expect(compareEndoHarnessSurfacesV0(base, edited)).toMatchObject({
			comparable: true,
			differs: ["tool-definitions"],
		});
		const order = compareEndoHarnessSurfacesV0(base, reordered);
		expect(order).toMatchObject({ comparable: true, same: false, differs: ["tool-order"] });
		// The ordered digest is the model-facing fact and is not normalized away; the membership digest is order-free.
		expect(componentsOf(reordered).tools.orderedDigest).not.toBe(componentsOf(base).tools.orderedDigest);
		expect(componentsOf(reordered).tools.membershipDigest).toBe(componentsOf(base).tools.membershipDigest);
		expect(componentsOf(reordered).identity).not.toBe(componentsOf(base).identity);
		// A duplicated tool is a different membership (multiset), not a no-op.
		const doubled = componentsOf(surfaceOf(chat({ tools: [readTool, bashTool, bashTool] })));
		expect(doubled.tools.membershipDigest).not.toBe(componentsOf(base).tools.membershipDigest);
	});

	it("6. a changed request parameter differs, naming the parameter and no content", () => {
		const base = surfaceOf(chat({ temperature: 0.2 }));
		const other = surfaceOf(chat({ temperature: 0.7 }));
		expect(compareEndoHarnessSurfacesV0(base, other)).toEqual({
			comparable: true,
			same: false,
			differs: ["parameters"],
			parameterNames: ["temperature"],
		});
		expect(componentsOf(other).identity).not.toBe(componentsOf(base).identity);
	});

	it("7. an absent sampling parameter stays absent: no default is invented", () => {
		const c = componentsOf(surfaceOf(chat()));
		expect(c.parameters.fields).not.toHaveProperty("temperature");
		expect(Object.keys(c.parameters.fields).filter((name) => /temperature|top_p|seed|penalty/.test(name))).toEqual(
			[],
		);
		expect(c.serverDefaults.status).toBe("UNAVAILABLE");
		expect(JSON.stringify(c)).not.toContain('"temperature"');
		// Sending temperature 1 is a different wire fact from omitting it.
		expect(componentsOf(surfaceOf(chat({ temperature: 1 }))).identity).not.toBe(c.identity);
		// `stream` absent is UNAVAILABLE, not false.
		const { stream: _stream, ...noStream } = chat();
		expect(componentsOf(surfaceOf(noStream)).streaming.status).toBe("UNAVAILABLE");
	});

	it("8. a changed model field differs; an absent one is UNAVAILABLE, never filled from configuration", () => {
		const a = surfaceOf(chat());
		const b = surfaceOf(chat({ model: "model-b" }));
		expect(compareEndoHarnessSurfacesV0(a, b)).toMatchObject({ differs: ["model"] });
		const { model: _model, ...unnamed } = chat();
		expect(componentsOf(surfaceOf(unnamed)).model).toEqual({
			status: "UNAVAILABLE",
			reason: "the request names no model",
		});
		expect(componentsOf(surfaceOf(unnamed)).identity).not.toBe(componentsOf(a).identity);
	});

	it("keeps model and stream out of the parameters, so they exist once", () => {
		const c = componentsOf(surfaceOf(chat()));
		expect(c.parameters.fields).not.toHaveProperty("model");
		expect(c.parameters.fields).not.toHaveProperty("stream");
		expect(requestParametersOfEndoHarnessSurfaceV0(surfaceOf(chat()))).toEqual({
			model: "model-a",
			stream: true,
			max_tokens: 4096,
		});
	});

	it("9. an unsupported request is explicitly UNAVAILABLE and nothing is guessed from its body", () => {
		const looksLikeChat = chat();
		const cases: [string, EndoHarnessSurfaceV0][] = [
			["another path", surfaceOf(looksLikeChat, key, { path: "/v1/embeddings" })],
			["another method", surfaceOf(looksLikeChat, key, { method: "GET" })],
			["not JSON", surfaceOf("{not json")],
			["not an object", surfaceOf("[1,2]")],
			["no messages", surfaceOf({ model: "m", prompt: "x" })],
			["a malformed message", surfaceOf(chat({ messages: ["hi"] }))],
			["tools not a list", surfaceOf(chat({ tools: { read: true } }))],
			["a non-string model", surfaceOf(chat({ model: 7 }))],
		];
		for (const [name, surface] of cases) {
			expect(surface.dialect.status, name).toBe("UNAVAILABLE");
			expect(surface.components.status, name).toBe("UNAVAILABLE");
			expect(readEndoVersionedV0(ENDO_HARNESS_SURFACE_VERSIONS_V0, surface).ok, name).toBe(true);
			expect(requestParametersOfEndoHarnessSurfaceV0(surface), name).toEqual({ unparsed: true });
		}
		// A query string does not change the endpoint.
		expect(surfaceOf(looksLikeChat, key, { path: "/v1/chat/completions?x=1" }).dialect.status).toBe("reported");
		expect(compareEndoHarnessSurfacesV0(cases[0]![1], surfaceOf(looksLikeChat))).toMatchObject({ comparable: false });
	});

	it("a missing body blob is reported as such, not thrown", () => {
		const store = record([{ body: chat() }]);
		const blobs = join(store, "capture", "blobs");
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((entry) =>
				statSync(join(dir, entry)).isDirectory() ? walk(join(dir, entry)) : [join(dir, entry)],
			);
		for (const file of walk(blobs)) rmSync(file);
		const [surface] = harnessSurfacesOfCaptureV0(store, key);
		expect(surface?.dialect).toEqual({ status: "UNAVAILABLE", reason: "the request body is not in the blob store" });
	});

	it("10. raw system, developer, tool and prompt text is absent from the canonical surface record", () => {
		const secret = "SYSTEM-SECRET-TEXT";
		const dev = "DEVELOPER-SECRET-TEXT";
		const toolText = "TOOL-DESCRIPTION-SECRET";
		const prompt = "USER-PROMPT-SECRET";
		const surface = surfaceOf(
			chat({
				messages: [
					{ role: "system", content: secret },
					{ role: "developer", content: dev },
					{ role: "user", content: prompt },
				],
				tools: [
					{
						type: "function",
						function: {
							name: "read",
							description: toolText,
							parameters: { type: "object", properties: { pathSECRET: {} } },
						},
					},
				],
			}),
		);
		const text = JSON.stringify(surface);
		for (const forbidden of [secret, dev, toolText, prompt, "pathSECRET"]) expect(text).not.toContain(forbidden);
		// And the digests are keyed: not the plain sha256 of the text (no confirmation oracle).

		const plain = createHash("sha256")
			.update(JSON.stringify({ role: "system", content: secret }))
			.digest("hex");
		expect(text).not.toContain(plain);
		// The raw request exists only in the keyed blob store, outside the canonical event log.
		const store = record([{ body: chat({ messages: [{ role: "system", content: secret }] }) }]);
		const events = readFileSync(join(store, "capture", "events", "events.log"), "utf8");
		expect(events).not.toContain(secret);
	});

	it("a long parameter value is recorded by digest only; a short one verbatim", () => {
		const long = "x".repeat(5000);
		const c = componentsOf(surfaceOf(chat({ stop: [long], seed: 3 })));
		expect(c.parameters.fields.stop).toEqual({ digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(c.parameters.fields.seed?.value).toBe(3);
		expect(JSON.stringify(c)).not.toContain(long);
		expect(componentsOf(surfaceOf(chat({ stop: [`${long}y`] }))).identity).not.toBe(c.identity);
	});

	it("11. surfaces from different digest domains are never silently comparable", () => {
		const a = surfaceOf(chat(), key);
		const b = surfaceOf(chat(), altKey);
		expect(componentsOf(a).identity).not.toBe(componentsOf(b).identity);
		expect(a.digestKey.keyId).not.toBe(b.digestKey.keyId);
		expect(compareEndoHarnessSurfacesV0(a, b)).toEqual({
			comparable: false,
			reason: "the surfaces were digested under different keys (different digest domains)",
		});
	});

	it("the identity is the keyed digest of the exported basis, and the basis carries no raw content", () => {
		const surface = surfaceOf(chat({ temperature: 0.2 }));
		const { identity, ...rest } = componentsOf(surface);
		const basis = endoHarnessSurfaceIdentityBasisV0(rest, "openai.chat-completions", surface.source.path);
		expect(key.digest(basis).value).toBe(identity);
		expect(JSON.stringify(basis)).not.toContain("coding agent");
		// Component digests are domain-separated from the keyed digest of the plain value.
		const message = (chat().messages as unknown[])[0];
		expect(componentsOf(surface).instructions.items[0]!.digest).not.toBe(key.digest(message as never).value);
	});

	it("is stable under key order and whitespace of the wire body", () => {
		const a = identityOf(JSON.stringify(chat({ temperature: 0.2 })));
		const reversed = JSON.stringify(
			Object.fromEntries(Object.entries(chat({ temperature: 0.2 })).reverse()),
			null,
			2,
		);
		expect(identityOf(reversed)).toBe(a);
	});

	it("reads several requests in capture order, with their exchanges", () => {
		const store = record([{ body: chat({}, "one") }, { body: chat({ model: "model-b" }, "two") }, { body: "oops" }]);
		const surfaces = harnessSurfacesOfCaptureV0(store, key);
		expect(surfaces.map((s) => s.source.exchange)).toEqual([1, 2, 3]);
		expect(surfaces.map((s) => s.dialect.status)).toEqual(["reported", "reported", "UNAVAILABLE"]);
	});

	it("derives from explicit input too (no store): a request digest under another key is refused as UNAVAILABLE", () => {
		const body = Buffer.from(JSON.stringify(chat()));
		const surface = deriveEndoHarnessSurfaceV0({
			key,
			captureVersion: null,
			exchange: 1,
			eventId: "endo.event.capture.x.1",
			method: "POST",
			path: "/v1/chat/completions",
			requestDigest: endoRequestDigestV0(altKey, "POST", "/v1/chat/completions", body),
			body,
		});
		expect(surface.dialect.status).toBe("UNAVAILABLE");
	});
});

const FIXTURES = join(import.meta.dirname, "fixtures", "schema-compat");
const fixture = (version: string, file: string) => JSON.parse(readFileSync(join(FIXTURES, version, file), "utf8"));

const contributions = {
	workingDirectory: { status: "reported", value: "/scratch/work", source: "runner" },
	invocationMode: { status: "reported", value: "pi --mode rpc", source: "runner" },
	configuredModel: { status: "reported", value: "p/model-a", source: "spec" },
} as const;

/** A v1 trial whose requests are the capture of `bodies`, through the real writer path. */
function trialOf(bodies: Body[], number: number, k = key): EndoExperimentTrialResultV1 {
	const surfaces = harnessSurfacesOfCaptureV0(
		record(
			bodies.map((body) => ({ body })),
			{ key: k },
		),
		k,
	);
	return {
		...(fixture("endo.experiment-trial.v1", "minimal.json") as EndoExperimentTrialResultV1),
		trial: number,
		harness: buildEndoTrialHarnessV0(surfaces, { ...contributions }),
	};
}

describe("a trial records its harness surface (endo.experiment-trial.v1) and historical trials keep their contract", () => {
	const read = (value: unknown) => readEndoExperimentTrialResultV0(value);

	it("12. the v0 fixtures still read exactly under v0: requestParameters stay, a harness field is refused", () => {
		for (const file of ["full.json", "minimal.json"]) {
			const v0 = fixture("endo.experiment-trial.v0", file);
			expect(read(v0)).toMatchObject({ ok: true, schemaVersion: "endo.experiment-trial.v0" });
			expect(read({ ...v0, harness: fixture("endo.experiment-trial.v1", "minimal.json").harness })).toMatchObject({
				ok: false,
				kind: "invalid",
			});
			const { requestParameters: _gone, ...without } = v0;
			expect(read(without)).toMatchObject({ ok: false, kind: "invalid" });
		}
		// Reading returns the value it was given: nothing migrated, defaulted or rewritten.
		const v0 = fixture("endo.experiment-trial.v0", "full.json");
		const result = read(v0);
		expect(result.ok && result.value).toBe(v0);
	});

	it("13. v1 refuses unknown fields and versions, a missing harness, a leftover requestParameters, and a bad embedded surface", () => {
		for (const file of ["full.json", "minimal.json"]) {
			const v1 = fixture("endo.experiment-trial.v1", file);
			expect(read(v1)).toMatchObject({ ok: true, schemaVersion: "endo.experiment-trial.v1" });
			expect(read({ ...v1, futureField: 1 })).toMatchObject({ ok: false, kind: "invalid" });
			expect(read({ ...v1, schemaVersion: "endo.experiment-trial.v2" })).toMatchObject({
				ok: false,
				kind: "unsupported-version",
			});
			const { harness: _h, ...without } = v1;
			expect(read(without)).toMatchObject({ ok: false, kind: "invalid" });
			expect(read({ ...v1, requestParameters: [] })).toMatchObject({ ok: false, kind: "invalid" });
			expect(read({ ...v1, harness: { ...v1.harness, extra: 1 } })).toMatchObject({ ok: false, kind: "invalid" });
			expect(
				read({ ...v1, harness: { ...v1.harness, contributions: { ...v1.harness.contributions, cwd: "x" } } }),
			).toMatchObject({ ok: false, kind: "invalid" });
			expect(
				read({
					...v1,
					harness: {
						...v1.harness,
						contributions: {
							...v1.harness.contributions,
							workingDirectory: { status: "reported", value: "/x", source: "prompt" },
						},
					},
				}),
			).toMatchObject({ ok: false, kind: "invalid" });
		}
		const full = fixture("endo.experiment-trial.v1", "full.json");
		const surfaces = full.harness.surfaces;
		expect(
			read({
				...full,
				harness: {
					...full.harness,
					surfaces: [{ ...surfaces[0], schemaVersion: "endo.harness-surface.v1" }, ...surfaces.slice(1)],
				},
			}),
		).toMatchObject({ ok: false, kind: "invalid" });
		expect(
			read({
				...full,
				harness: { ...full.harness, surfaces: [{ ...surfaces[0], futureField: 1 }, ...surfaces.slice(1)] },
			}),
		).toMatchObject({ ok: false, kind: "invalid" });
		const requests = [{ ...full.harness.requests[0], surface: 99 }];
		expect(read({ ...full, harness: { ...full.harness, requests } })).toMatchObject({ ok: false, kind: "invalid" });
	});

	it("the v0 record's parameters equal the v1 view of the same bodies: one parser underneath", () => {
		const bodies = [
			chat({ temperature: 0.2, tool_choice: "auto" }),
			chat({ model: "model-b", top_p: 0.9 }, "other task"),
		];
		const trial = trialOf(bodies, 0);
		const old = bodies.map(({ messages: _m, tools: _t, ...rest }: Record<string, unknown>) => rest);
		expect(requestParametersOfTrialV0(trial).map((p) => canonicalEndoJsonV0(p))).toEqual(
			old.map((p) => canonicalEndoJsonV0(p)),
		);
		// A v0 trial answers with its recorded list, unchanged.
		const v0 = fixture("endo.experiment-trial.v0", "full.json");
		expect(requestParametersOfTrialV0(v0)).toBe(v0.requestParameters);
	});

	it("deduplicates repeated surfaces but keeps every request and any surface that changed mid-trial", () => {
		const trial = trialOf([chat({}, "a"), chat({}, "b"), chat({ temperature: 0.5 }, "c"), chat({}, "d")], 0);
		expect(trial.harness.surfaces).toHaveLength(2);
		expect(trial.harness.requests.map((r) => r.surface)).toEqual([0, 0, 1, 0]);
		expect(trial.harness.requests.map((r) => r.exchange)).toEqual([1, 2, 3, 4]);
		expect(read(JSON.parse(JSON.stringify(trial)))).toMatchObject({ ok: true });
	});
});

describe("the cell summary of harness surfaces", () => {
	const same = (n: number) => trialOf([chat({}, `task ${n}`), chat({}, `task ${n} again`)], n);

	it("14. matched trials report one surface; a differing trial is reported as a mismatch with the coordinate, not as invalid", () => {
		const matched = summarizeEndoCellHarnessSurfacesV0([same(0), same(1), same(2)]) as Record<string, unknown>;
		expect(matched).toMatchObject({ status: "reported", distinctSurfaces: 1, matched: true, comparable: true });
		const reordered = trialOf([chat({ tools: [bashTool, readTool] })], 2);
		const mismatch = summarizeEndoCellHarnessSurfacesV0([same(0), same(1), reordered]) as Record<string, unknown>;
		expect(mismatch).toMatchObject({
			distinctSurfaces: 2,
			matched: false,
			trialsDifferingFromModalSet: ["trial #2"],
			differences: [{ differs: ["tool-order"], parameterNames: [] }],
		});
		// The summary carries digests and coordinate names only.
		const text = JSON.stringify(mismatch);
		for (const raw of ["coding agent", "Read a file", "fix the failing test"]) expect(text).not.toContain(raw);
		const parameter = summarizeEndoCellHarnessSurfacesV0([same(0), trialOf([chat({ temperature: 0.9 })], 1)]) as {
			differences: { differs: string[]; parameterNames: string[] }[];
		};
		expect(parameter.differences[0]).toMatchObject({ differs: ["parameters"], parameterNames: ["temperature"] });
	});

	it("a surface that changes inside one trial is visible as within-trial variation", () => {
		const s = summarizeEndoCellHarnessSurfacesV0([
			trialOf([chat(), chat({ model: "model-b" })], 0),
			same(1),
		]) as Record<string, unknown>;
		expect(s).toMatchObject({ withinTrialVariation: ["trial #0"], matched: false });
	});

	it("trials from different digest domains are not comparable, never reported as different", () => {
		const s = summarizeEndoCellHarnessSurfacesV0([same(0), trialOf([chat()], 1, altKey)]) as Record<string, unknown>;
		expect(s).toMatchObject({ comparable: false, matched: null, differences: [], trialsDifferingFromModalSet: [] });
	});

	it("historical v0 trials predate the surface: UNAVAILABLE for them, and never a mismatch against v1 trials", () => {
		const v0 = fixture("endo.experiment-trial.v0", "full.json") as EndoExperimentTrialResultAnyV0;
		expect(summarizeEndoCellHarnessSurfacesV0([v0])).toMatchObject({
			status: "UNAVAILABLE",
			trials: { withSurface: 0, predatingSurface: 1 },
		});
		expect(summarizeEndoCellHarnessSurfacesV0([v0, same(0), same(1)])).toMatchObject({
			status: "reported",
			matched: true,
			trials: { withSurface: 2, predatingSurface: 1 },
		});
		expect(summarizeEndoCellHarnessSurfacesV0([])).toMatchObject({ status: "UNAVAILABLE" });
	});

	it("unrecognized requests are counted, have no components, and are never a mismatch", () => {
		const s = summarizeEndoCellHarnessSurfacesV0([trialOf([chat(), "not json"], 0), same(1)]) as Record<
			string,
			unknown
		>;
		expect(s).toMatchObject({ matched: true, requests: { observed: 4, recognized: 3, unrecognized: 1 } });
	});
});

describe("review findings", () => {
	const same = (n: number) => trialOf([chat({}, `task ${n}`)], n);

	it("a trial with no recognized request is not a surface: never matched, never differing", () => {
		const none = trialOf(["not json"], 1);
		const mixed = summarizeEndoCellHarnessSurfacesV0([same(0), none, same(2)]) as Record<string, unknown>;
		expect(mixed).toMatchObject({
			matched: true,
			trialsDifferingFromModalSet: [],
			trials: { withSurface: 2, noRecognizedSurface: 1 },
		});
		expect(surfaceLine("t", "c", mixed as never)).toContain("1 trial(s) showed no recognized request");
		const all = summarizeEndoCellHarnessSurfacesV0([none, trialOf(["still not json"], 2)]);
		expect(all).toMatchObject({ status: "UNAVAILABLE", trials: { withSurface: 0, noRecognizedSurface: 2 } });
	});

	it("a top-level __proto__ request parameter is recorded as an own parameter", () => {
		const body = `{"model":"model-a","stream":true,"messages":[{"role":"system","content":"s"}],"__proto__":{"x":1},"max_tokens":5}`;
		const c = componentsOf(surfaceOf(body));
		expect(Object.keys(c.parameters.fields)).toEqual(["__proto__", "max_tokens"]);
		expect(Object.hasOwn(c.parameters.fields, "__proto__")).toBe(true);
		const other = componentsOf(surfaceOf(body.replace('{"x":1}', '{"x":2}')));
		expect(other.identity).not.toBe(c.identity);
		const view = requestParametersOfEndoHarnessSurfaceV0(surfaceOf(body)) as Record<string, unknown>;
		expect(Object.hasOwn(view, "__proto__")).toBe(true);
	});

	it("the surface table a v1 trial embeds is its own, pinned to v0", () => {
		expect(ENDO_EXPERIMENT_TRIAL_SURFACE_VERSIONS_V1).not.toBe(ENDO_HARNESS_SURFACE_VERSIONS_V0);
	});

	it("a cell that consistently shows several surfaces is a mismatch headline, not matched", () => {
		const two = (n: number) => trialOf([chat({}, `a${n}`), chat({ temperature: 0.2 }, `b${n}`)], n);
		const s = summarizeEndoCellHarnessSurfacesV0([two(0), two(1)]) as Record<string, unknown>;
		expect(s).toMatchObject({ distinctSurfaces: 2, matched: true });
		expect(surfaceLine("t", "c", s as never)).toContain("MISMATCH: 2 distinct surfaces in this cell");
	});

	it("invalid UTF-8 inside otherwise valid JSON is not a recognized body", () => {
		const bytes = Buffer.concat([
			Buffer.from('{"messages":[{"role":"system","content":"a'),
			Buffer.from([0xff]),
			Buffer.from('b"}]}'),
		]);
		const surface = harnessSurfacesOfCaptureV0(record([{ body: bytes as never }]), key)[0]!;
		expect(surface.components.status).toBe("UNAVAILABLE");
	});

	it("an overflowing number makes the request unavailable instead of aborting the derivation", () => {
		const surface = surfaceOf('{"messages":[{"role":"user","content":"x"}],"temperature":1e400}');
		expect(surface.components.status).toBe("UNAVAILABLE");
	});

	it("the request target is part of the identity and is named as a coordinate", () => {
		const a = surfaceOf(chat(), key, { path: "/v1/chat/completions?api-version=a" });
		const b = surfaceOf(chat(), key, { path: "/v1/chat/completions?api-version=b" });
		const c = surfaceOf(chat(), key, { path: "/chat/completions" });
		expect(componentsOf(a).identity).not.toBe(componentsOf(b).identity);
		expect(componentsOf(a).identity).not.toBe(componentsOf(c).identity);
		expect(compareEndoHarnessSurfacesV0(a, b)).toMatchObject({ comparable: true, differs: ["target"] });
		expect(compareEndoHarnessSurfacesV0(a, a)).toMatchObject({ same: true, differs: [] });
	});

	it("a v1 trial refuses a surface that no request references", () => {
		const trial = trialOf([chat()], 0);
		const orphan = trialOf([chat({ temperature: 0.9 })], 1).harness.surfaces[0]!;
		const bad = { ...trial, harness: { ...trial.harness, surfaces: [...trial.harness.surfaces, orphan] } };
		expect(readEndoExperimentTrialResultV0(bad).ok).toBe(false);
		expect(readEndoExperimentTrialResultV0(trial).ok).toBe(true);
	});

	it("the configured model is sourced from the spec, and a contribution source is runner or spec only", () => {
		const trial = trialOf([chat()], 0);
		expect(trial.harness.contributions.configuredModel).toMatchObject({ source: "spec" });
		const bad = {
			...trial,
			harness: {
				...trial.harness,
				contributions: {
					...trial.harness.contributions,
					configuredModel: { status: "reported", value: "p/m", source: "wire" },
				},
			},
		};
		expect(readEndoExperimentTrialResultV0(bad).ok).toBe(false);
	});

	it("a non-finite number in an ignored message still makes the request unavailable", () => {
		const surface = surfaceOf('{"messages":[{"role":"user","content":1e400}]}');
		expect(surface.components.status).toBe("UNAVAILABLE");
	});

	it("a long recorded target is a valid surface; a reported dialect needs a chat-completions source", () => {
		const long = `/v1/chat/completions?q=${"a".repeat(10000)}`;
		const surface = surfaceOf(chat(), key, { path: long });
		expect(readEndoVersionedV0(ENDO_HARNESS_SURFACE_VERSIONS_V0, surface).ok).toBe(true);
		for (const source of [
			{ ...surface.source, method: "GET" },
			{ ...surface.source, path: "/v1/embeddings" },
		])
			expect(readEndoVersionedV0(ENDO_HARNESS_SURFACE_VERSIONS_V0, { ...surface, source }).ok).toBe(false);
	});

	it("contributions are summarized over every v1 trial, including those with no recognized request", () => {
		const none = trialOf(["not json"], 1);
		const other = {
			...none,
			harness: {
				...none.harness,
				contributions: {
					...none.harness.contributions,
					configuredModel: { status: "reported", value: "p/other", source: "spec" },
				},
			},
		} as EndoExperimentTrialResultV1;
		const mixed = summarizeEndoCellHarnessSurfacesV0([trialOf([chat()], 0), other]) as {
			contributions: { configuredModel: { distinct: number } };
		};
		expect(mixed.contributions.configuredModel.distinct).toBe(2);
		const all = summarizeEndoCellHarnessSurfacesV0([other]) as { status: string; contributions?: unknown };
		expect(all.status).toBe("UNAVAILABLE");
		expect(all.contributions).toBeDefined();
	});

	it("model and streaming compare by member, not by serialized key order", () => {
		const a = surfaceOf(chat());
		const flipped = JSON.parse(JSON.stringify(a));
		flipped.components.value.model = { value: "model-a", status: "reported" };
		flipped.components.value.streaming = { value: true, status: "reported" };
		expect(compareEndoHarnessSurfacesV0(a, flipped)).toMatchObject({ comparable: true, same: true, differs: [] });
	});

	it("a persisted parameter value over the size limit, or a malformed key id, is refused", () => {
		const surface = JSON.parse(JSON.stringify(surfaceOf(chat())));
		surface.components.value.parameters.fields.big = { digest: "a".repeat(64), value: "x".repeat(2000) };
		expect(readEndoVersionedV0(ENDO_HARNESS_SURFACE_VERSIONS_V0, surface).ok).toBe(false);
		const keyed = JSON.parse(JSON.stringify(surfaceOf(chat())));
		keyed.digestKey.keyId = "bad\u0000id";
		expect(readEndoVersionedV0(ENDO_HARNESS_SURFACE_VERSIONS_V0, keyed).ok).toBe(false);
	});

	it("the protocol-side key id pattern is the keyed-digest contract's", () => {
		expect(ENDO_HARNESS_SURFACE_KEY_ID_PATTERN_V0.source).toBe(ENDO_DIGEST_KEY_ID_PATTERN_V0.source);
	});

	it("the size limit is one measure for the producer and the validator, and a deep value is refused, not a crash", () => {
		// 1022 characters is 1024 compact bytes: kept verbatim by the producer, accepted by the validator.
		const edge = componentsOf(surfaceOf(chat({ note: "x".repeat(1022) }))).parameters.fields.note!;
		expect("value" in edge).toBe(true);
		const over = componentsOf(surfaceOf(chat({ note: "x".repeat(1023) }))).parameters.fields.note!;
		expect("value" in over).toBe(false);
		const surface = JSON.parse(JSON.stringify(surfaceOf(chat())));
		let deep: unknown = "x";
		for (let i = 0; i < 20000; i++) deep = [deep];
		surface.components.value.parameters.fields.deep = { digest: "a".repeat(64), value: deep };
		expect(readEndoVersionedV0(ENDO_HARNESS_SURFACE_VERSIONS_V0, surface).ok).toBe(false);
	});

	it("each listed surface must be the source of a request that names it", () => {
		const trial = trialOf([chat()], 0);
		const moved = {
			...trial,
			harness: {
				...trial.harness,
				requests: trial.harness.requests.map((r) => ({ ...r, exchange: r.exchange + 7 })),
			},
		};
		expect(readEndoExperimentTrialResultV0(moved).ok).toBe(false);
		expect(readEndoExperimentTrialResultV0(trial).ok).toBe(true);
	});

	it("a parameter name with Markdown or newlines cannot add lines to the summary", () => {
		const s = summarizeEndoCellHarnessSurfacesV0([
			trialOf([chat()], 0),
			trialOf([chat({ "x\n## injected\n- evil": 1 })], 1),
		]);
		expect(surfaceLine("t", "c", s).split("\n")).toHaveLength(1);
	});

	it("an unrecognized request's sampling parameters are unknown; a legal `unparsed` parameter is not that marker", () => {
		const keys = ["temperature"];
		expect(
			samplingOfParameters(
				[
					{ parameters: { unparsed: true }, recognized: false },
					{ parameters: { model: "m" }, recognized: true },
				],
				keys,
			),
		).toEqual({ samplingUnknown: true, samplingSent: [{}], samplingFields: [] });
		const legal = trialOf(['{"messages":[],"unparsed":true}'], 0);
		const observed = requestParameterObservationsOfTrialV0(legal);
		expect(observed).toEqual([{ parameters: { unparsed: true }, recognized: true }]);
		expect(samplingOfParameters(observed, keys)).toEqual({
			samplingUnknown: false,
			samplingSent: [{}],
			samplingFields: [],
		});
		expect(requestParameterObservationsOfTrialV0(trialOf(["not json"], 1))[0]!.recognized).toBe(false);
	});

	it("each contribution has its declared source, and a repeated exchange is refused", () => {
		const trial = trialOf([chat()], 0);
		const swap = (name: string, source: string) => ({
			...trial,
			harness: {
				...trial.harness,
				contributions: {
					...trial.harness.contributions,
					[name]: { ...(trial.harness.contributions as Record<string, object>)[name], source },
				},
			},
		});
		expect(readEndoExperimentTrialResultV0(swap("workingDirectory", "spec")).ok).toBe(false);
		expect(readEndoExperimentTrialResultV0(swap("configuredModel", "runner")).ok).toBe(false);
		const dup = {
			...trial,
			harness: { ...trial.harness, requests: [...trial.harness.requests, ...trial.harness.requests] },
		};
		expect(readEndoExperimentTrialResultV0(dup).ok).toBe(false);
	});

	describe("the request and surface tables", () => {
		const two = () => trialOf([chat(), chat({ temperature: 0.2 }), chat()], 0);
		/** A governed refusal naming the invariant, never a thrown exception. */
		const refused = (trial: unknown, because: RegExp) => {
			const read = readEndoExperimentTrialResultV0(trial);
			expect(read.ok).toBe(false);
			expect(JSON.stringify(read)).toMatch(because);
		};

		it("the producer's own table is accepted: first-observed order, repeated surfaces deduplicated", () => {
			const trial = two();
			expect(trial.harness.surfaces).toHaveLength(2);
			expect(trial.harness.requests.map((r) => r.surface)).toEqual([0, 1, 0]);
			expect(readEndoExperimentTrialResultV0(trial).ok).toBe(true);
		});

		it("requests out of capture order are refused, not reordered", () => {
			const trial = two();
			const swapped = [trial.harness.requests[1]!, trial.harness.requests[0]!, trial.harness.requests[2]!];
			refused({ ...trial, harness: { ...trial.harness, requests: swapped } }, /strictly increasing exchange order/);
			refused(
				{ ...trial, harness: { ...trial.harness, requests: [...trial.harness.requests].reverse() } },
				/strictly increasing exchange order/,
			);
		});

		it("a surface table out of first-observed order, or naming a surface early, is refused", () => {
			const trial = two();
			const [a, b] = trial.harness.surfaces;
			refused(
				{
					...trial,
					harness: {
						...trial.harness,
						surfaces: [b, a],
						requests: trial.harness.requests.map((r) => ({ ...r, surface: 1 - r.surface })),
					},
				},
				/before its first observation/,
			);
			refused(
				{
					...trial,
					harness: { ...trial.harness, requests: trial.harness.requests.map((r) => ({ ...r, surface: 0 })) },
				},
				/is not referenced by any request/,
			);
		});

		it("duplicate recognized identities in the surface table are refused", () => {
			const trial = trialOf([chat(), chat({}, "another task")], 0);
			const [only] = trial.harness.surfaces;
			const second = { ...only!, source: { ...only!.source, exchange: 2, eventId: "e2" } };
			refused(
				{
					...trial,
					harness: {
						...trial.harness,
						surfaces: [only, second],
						requests: [trial.harness.requests[0]!, { ...trial.harness.requests[1]!, exchange: 2, surface: 1 }],
					},
				},
				/repeats the identity of an earlier surface/,
			);
		});

		it("duplicate unrecognized event identities are refused; distinct ones are kept apart", () => {
			const trial = trialOf(["not json", "also not json"], 0);
			expect(trial.harness.surfaces).toHaveLength(2);
			expect(readEndoExperimentTrialResultV0(trial).ok).toBe(true);
			const [first] = trial.harness.surfaces;
			const second = { ...first!, source: { ...first!.source, exchange: 2, requestDigest: "b".repeat(64) } };
			refused(
				{
					...trial,
					harness: {
						...trial.harness,
						surfaces: [first, second],
						requests: [trial.harness.requests[0]!, { exchange: 2, requestDigest: "b".repeat(64), surface: 1 }],
					},
				},
				/repeats the identity of an earlier surface/,
			);
		});

		it("a request whose source does not match the first request naming its surface is refused", () => {
			const trial = two();
			const requests = trial.harness.requests.map((r, i) => (i === 0 ? { ...r, requestDigest: "c".repeat(64) } : r));
			refused({ ...trial, harness: { ...trial.harness, requests } }, /is not the source of the first request/);
		});

		it("malformed imported data is refused without an exception", () => {
			const trial = two();
			for (const bad of [
				{ ...trial, harness: { ...trial.harness, requests: [{ exchange: -1, requestDigest: "x", surface: 99 }] } },
				{ ...trial, harness: { ...trial.harness, surfaces: [null] } },
				{ ...trial, harness: null },
				{ ...trial, harness: { ...trial.harness, requests: "no" } },
			])
				expect(() => readEndoExperimentTrialResultV0(bad)).not.toThrow();
		});
	});

	it("sampling field names are unknown, not an empty list, once any request was unrecognized", () => {
		const recognized = samplingOfParameters(
			requestParameterObservationsOfTrialV0(trialOf([chat({ temperature: 0.3 })], 0)),
			["temperature"],
		);
		expect(recognized).toMatchObject({ samplingUnknown: false, samplingFields: ["temperature"] });
		const mixed = samplingOfParameters(
			requestParameterObservationsOfTrialV0(trialOf([chat({ temperature: 0.3 }), "not json"], 0)),
			["temperature"],
		);
		expect(mixed.samplingUnknown).toBe(true);
	});
});
