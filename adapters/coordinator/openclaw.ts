import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { get, type IncomingMessage } from "node:http";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { externalEndophasiaStatusV0 } from "../../integrations/openclaw-endophasia-status/src/status-reader.ts";
import {
	type EndoCoordinatorCoordinationV0,
	validateEndoCoordinatorCoordinationV0,
} from "../../protocol/coordinator-coordination.ts";
import { type EndoCoordinatorStatusV0, validateEndoCoordinatorStatusV0 } from "../../protocol/coordinator-status.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "../../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	ENDO_COORDINATOR_INSTRUCTIONS_V0,
	ENDO_COORDINATOR_TOOL_DEFINITION_V0,
	ENDO_COORDINATOR_TOOL_V0,
	type EndoCoordinatorBriefDiagnosticsV1,
	type EndoCoordinatorBriefRefusalV0,
	type EndoCoordinatorBriefRequestV0,
	type EndoCoordinatorBriefResultV0,
	type EndoCoordinatorBriefSubstrateV0,
	type EndoCoordinatorDiagnosticStageV1,
	type EndoCoordinatorExchangeDiagnosticV1,
	type EndoCoordinatorTerminationClassV1,
} from "../../runtime/contracts/coordinator-brief.ts";
import { endoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { EndoCaptureLogV0 } from "../openai-proxy/capture-log.ts";
import { bridgedCommandV0, type EndoModelRelayV0, modelRelayMountsV0 } from "../sandbox/model-relay.ts";
import {
	coordinatorInferenceForV0,
	ENDO_COORDINATOR_M0_TARGET_V0,
	type EndoCoordinatorInferenceV0,
	type EndoCoordinatorModelTargetV0,
	startCoordinatorModelRelayV0,
} from "./model-relay.ts";
import {
	COORDINATOR_ENV_V0,
	coordinatorAnswerRefusalV0,
	coordinatorBwrapV0,
	readCoordinatorBriefStatusV0,
} from "./status.ts";
import type { coordinatorWireV0 } from "./wire.ts";

export const ENDO_COORDINATOR_SUPPORTED_OPENCLAW_VERSIONS_V0 = Object.freeze(["2026.11.7", "2026.11.10"] as const);
export const ENDO_COORDINATOR_HARNESS_V0 = "OpenClaw 2026.11.7";
const HARNESS = ENDO_COORDINATOR_HARNESS_V0;
const PROVIDER = "endo-local";
const PORT = 18091;
const PLUGIN = "endo-coordinator";
const SCRATCH = "/scratch";
function pluginEntry(projectId: string, toolText: string, inference: EndoCoordinatorInferenceV0) {
	return `import { appendFileSync } from "node:fs";
const project = ${JSON.stringify(projectId)};
const tool = ${JSON.stringify({ ...ENDO_COORDINATOR_TOOL_DEFINITION_V0, label: "Endophasia Status" })};
const status = ${JSON.stringify(toolText)};
const settings = ${JSON.stringify(inference)};
function refusal(name, params) {
  if (name !== tool.name) return "tool-not-permitted";
  if (!params || typeof params !== "object" || Array.isArray(params)) return "malformed-selector";
  const keys = Object.keys(params);
  if (!keys.length) return null;
  if (keys.length !== 1 || keys[0] !== "project" || typeof params.project !== "string" || !new RegExp(tool.parameters.properties.project.pattern).test(params.project)) return "malformed-selector";
  return params.project === project ? null : "project-out-of-scope";
}
export default { id: ${JSON.stringify(PLUGIN)}, name: "Endophasia Coordinator", register(api) {
  api.on("before_tool_call", ({ toolName, params }) => {
    const code = refusal(toolName, params);
    if (code) return { block: true, blockReason: code };
  });
  api.registerTool({ ...tool, execute: async (_id, params) => {
    const code = refusal(tool.name, params);
    if (code) return { content: [{ type: "text", text: code }], details: {} };
    appendFileSync("/scratch/dispatch", "called\\n", { mode: 0o600 });
    return { content: [{ type: "text", text: status }], details: {} };
  } }, { optional: true });
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER)}, label: "Local llama.cpp coordinator", auth: [],
    wrapStreamFn({ streamFn }) {
      if (!streamFn) return null;
      return (model, context, options) => streamFn(model, context, { ...options,
        onPayload: async (payload, m) => {
          const next = await options?.onPayload?.(payload, m) ?? payload;
          for (const k of [
            "max_completion_tokens",
            "n_predict",
            "reasoning_effort",
            "reasoning_budget_tokens",
            "thinking_budget_tokens",
            "reasoning_budget",
            "reasoning_format",
            "reasoning",
            "thinking",
            "chat_template_kwargs",
            "enable_thinking",
          ]) delete next[k];
          Object.assign(next, settings);
          return next;
        }
      });
    }
  });
}};`;
}

const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

function configure(
	directory: string,
	projectId: string,
	toolText: string,
	bearer: string,
	extraTool: boolean,
	target: EndoCoordinatorModelTargetV0,
) {
	const inference = coordinatorInferenceForV0(target);
	for (const dir of ["home", "state", "workspace", "plugin"]) mkdirSync(join(directory, dir), { mode: 0o700 });
	put(join(directory, "plugin", "package.json"), {
		name: PLUGIN,
		version: "0.1.0",
		type: "module",
		openclaw: { extensions: ["./index.mjs"] },
	});
	put(join(directory, "plugin", "openclaw.plugin.json"), {
		id: PLUGIN,
		name: "Endophasia Coordinator",
		providers: [PROVIDER],
		contracts: { tools: [ENDO_COORDINATOR_TOOL_V0] },
		configSchema: { type: "object", additionalProperties: false, properties: {} },
	});
	writeFileSync(join(directory, "plugin", "index.mjs"), pluginEntry(projectId, toolText, inference), { mode: 0o600 });
	const modelRef = `${PROVIDER}/${target.model}`;
	put(join(directory, "config.json"), {
		agents: {
			defaults: {
				model: { primary: modelRef, fallbacks: [] },
				workspace: `${SCRATCH}/workspace`,
				skipBootstrap: true,
			},
			entries: { coordinator: { skills: [] } },
		},
		memory: { search: { enabled: false } },
		models: {
			mode: "replace",
			providers: {
				[PROVIDER]: {
					baseUrl: `http://127.0.0.1:${PORT}/v1`,
					api: "openai-completions",
					apiKey: bearer,
					models: [
						{
							id: target.model,
							name: target.model,
							input: ["text"],
							reasoning: false,
							contextWindow: 32_768,
							maxTokens: inference.max_tokens,
						},
					],
				},
			},
		},
		skills: { allowBundled: [] },
		plugins: {
			allow: [PLUGIN],
			load: { paths: [`${SCRATCH}/plugin`] },
			slots: { memory: "none" },
			entries: { [PLUGIN]: { enabled: true } },
		},
		tools: { allow: [ENDO_COORDINATOR_TOOL_V0, ...(extraTool ? ["read"] : [])], toolSearch: false },
	});
}

const MAX_CAPTURED_STDERR_BYTES_V1 = 8192;

const execute = (args: string[], signal: AbortSignal, timeoutMs: number) =>
	new Promise<{ ok: boolean; stderr: string }>((resolve) => {
		if (signal.aborted) {
			resolve({ ok: false, stderr: "" });
			return;
		}
		// Discard stdout (`ignore`) so large OpenClaw `--json` payloads can never trip maxBuffer (F8).
		const child = spawn("/usr/bin/bwrap", args, {
			env: COORDINATOR_ENV_V0,
			stdio: ["ignore", "ignore", "pipe"],
			signal,
			killSignal: "SIGKILL",
		});
		const stderrChunks: Buffer[] = [];
		let stderrBytes = 0;
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrBytes >= MAX_CAPTURED_STDERR_BYTES_V1) return;
			const remaining = MAX_CAPTURED_STDERR_BYTES_V1 - stderrBytes;
			const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
			stderrChunks.push(slice);
			stderrBytes += slice.length;
		});
		let settled = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// already exited
			}
		}, timeoutMs + 20_000);
		timer.unref?.();
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok, stderr: Buffer.concat(stderrChunks).toString("utf8") });
		};
		child.once("error", () => done(false));
		child.once("close", (code, sig) => done(!timedOut && !signal.aborted && code === 0 && sig === null));
	});

async function providerBuild(origin: string, deadlineSignal?: AbortSignal) {
	const timeout = AbortSignal.timeout(3000);
	const signal = deadlineSignal === undefined ? timeout : AbortSignal.any([timeout, deadlineSignal]);
	const response = await new Promise<IncomingMessage>((resolve, reject) => {
		get(`${origin}/props`, { signal, agent: false }, resolve).once("error", reject);
	});
	const parts: Buffer[] = [];
	let length = 0;
	try {
		if (response.statusCode !== 200) throw new Error("local router unavailable");
		for await (const chunk of response) {
			length += chunk.length;
			if (length > 64 * 1024) throw new Error("local router properties exceed the bound");
			parts.push(chunk);
		}
	} finally {
		response.destroy();
	}
	const props = JSON.parse(Buffer.concat(parts).toString("utf8"));
	if (
		props.role !== "router" ||
		typeof props.build_info !== "string" ||
		!/^b[0-9]+-[0-9a-f]{7,40}$/.test(props.build_info)
	)
		throw new Error("unexpected local router");
	return `llama.cpp ${props.build_info}`;
}

export interface OpenClawCoordinatorTrialV0 {
	readonly promptSha256: string;
	readonly inference: EndoCoordinatorInferenceV0;
	readonly wire: ReturnType<typeof coordinatorWireV0>["trace"];
	readonly dispatched: boolean;
	readonly toolOutcome: unknown;
	readonly evidence: Extract<EndoCoordinatorBriefResultV0, { availability: "available" }>["evidence"];
	readonly latencyMs: number;
	/** From starting the sandboxed agent to its exit: the inference-bearing part of the turn. */
	readonly inferenceElapsedMs: number;
	/** Requests the relay admitted to the model server (each a completion request, whatever came back). */
	readonly admittedExchanges: number;
	readonly recorderClean: boolean;
	readonly stderr: string;
}

export function pinnedCoordinatorBriefStatusV0(
	root: string,
	projectId: string,
	pinned: {
		readonly status: EndoCoordinatorStatusV0;
		readonly coordination: EndoCoordinatorCoordinationV0;
	},
) {
	try {
		const status = validateEndoCoordinatorStatusV0(pinned.status);
		const coordination = validateEndoCoordinatorCoordinationV0(pinned.coordination);
		if (
			status.scope.requested?.length !== 1 ||
			status.scope.requested[0] !== projectId ||
			status.projects.length !== 1 ||
			status.projects[0]?.id !== projectId ||
			coordination.scope.requested?.length !== 1 ||
			coordination.scope.requested[0] !== projectId ||
			coordination.projects.some((p) => p.id !== projectId)
		)
			return { ok: false, reason: "invalid-status-scope" } as const;
		const view = externalEndophasiaStatusV0(status, {
			endo: { node: process.execPath, entry: "" },
			storeRoot: root,
			projects: [{ id: projectId, root }],
		});
		return {
			ok: true,
			view,
			coordination,
			evidence: {
				readAtMs: status.readAtMs,
				projectionSha256: sha256HexV0(canonicalEndoJsonV0(status)),
				modelViewSha256: sha256HexV0(canonicalEndoJsonV0(view)),
			},
		} as const;
	} catch {
		return { ok: false, reason: "invalid-status" } as const;
	}
}

const nonNegInt = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function terminationClassFromRefusalV1(
	reason: EndoCoordinatorBriefRefusalV0 | null,
): EndoCoordinatorTerminationClassV1 {
	if (reason === null) return "completed-published";
	switch (reason) {
		case "reasoning-budget-exhausted":
		case "generation-limit":
		case "inference-timeout":
		case "model-unavailable":
		case "runtime-unavailable":
			return reason;
		case "receipt-absence-unestablished":
		case "event-absence-unestablished":
		case "tool-expansion-suggested":
		case "verification-positive-contradiction":
		case "ungrounded":
			return "grounding-refused";
		default:
			return "other-refusal";
	}
}

function buildDiagnosticsV1(args: {
	readonly target: EndoCoordinatorModelTargetV0;
	readonly stages: readonly EndoCoordinatorDiagnosticStageV1[];
	readonly openclawExitOk: boolean | null;
	readonly wire?: ReturnType<typeof coordinatorWireV0>["trace"];
	readonly refusal: EndoCoordinatorBriefRefusalV0 | null;
}): EndoCoordinatorBriefDiagnosticsV1 {
	const exchanges: EndoCoordinatorExchangeDiagnosticV1[] = (args.wire?.responses ?? []).map((resp, idx) => {
		const u =
			resp.usage !== null && typeof resp.usage === "object" && !Array.isArray(resp.usage)
				? (resp.usage as Record<string, unknown>)
				: null;
		return Object.freeze({
			exchange: idx + 1,
			finishReason: resp.finish,
			toolCalled: resp.toolCalled,
			sawReasoning: resp.sawReasoning ?? false,
			reasoningChars: resp.reasoningChars ?? 0,
			sawVisibleContent: resp.sawVisibleContent ?? resp.text.length > 0,
			visibleChars: resp.visibleChars ?? resp.text.length,
			promptTokens: nonNegInt(u?.prompt_tokens),
			completionTokens: nonNegInt(u?.completion_tokens),
			reasoningTokens: resp.reasoningTokens ?? null,
		});
	});
	return Object.freeze({
		schemaVersion: "endo.coordinator-brief-diagnostics.v1",
		terminationClass: terminationClassFromRefusalV1(args.refusal),
		stagesReached: Object.freeze([...args.stages]),
		openclawExitOk: args.openclawExitOk,
		exchanges: Object.freeze(exchanges),
		effectiveMaxOutputTokens: args.target.maxOutputTokens,
		reasoningControlMode: "unchanged",
		rawReasoningStored: false,
	});
}

export async function runOpenClawCoordinatorV0(
	root: string,
	request: EndoCoordinatorBriefRequestV0,
	options: {
		openclaw?: string;
		origin?: string;
		extraTool?: boolean;
		trial?: (trial: OpenClawCoordinatorTrialV0) => void;
		/** The inference target; M0's by default. `origin` still overrides its origin (tests). */
		target?: EndoCoordinatorModelTargetV0;
		/** The provider identity a pool observation already established; skips M0's router `/props` gate. */
		provider?: string;
		/** Cancels the briefing: a cancelled briefing is unavailable, whatever arrived. */
		signal?: AbortSignal;
		/** Aborts the briefing when the caller's absolute dispatch/inference deadline expires (`inference-timeout`). */
		deadlineSignal?: AbortSignal;
		pinnedObservation?: {
			readonly status: EndoCoordinatorStatusV0;
			readonly coordination: EndoCoordinatorCoordinationV0;
		};
	} = {},
): Promise<EndoCoordinatorBriefResultV0> {
	const started = performance.now();
	const { projectId } = request;
	const target: EndoCoordinatorModelTargetV0 = Object.freeze({
		...(options.target ?? ENDO_COORDINATOR_M0_TARGET_V0),
		...(options.origin === undefined ? {} : { origin: options.origin }),
	});
	const hostDeadlineAt = target.hostDeadline ? started + target.timeoutMs : null;
	const isExternalCancellation = () => options.signal?.aborted === true && options.signal !== options.deadlineSignal;
	const isDeadlineExceeded = () =>
		options.deadlineSignal?.aborted === true || (hostDeadlineAt !== null && performance.now() >= hostDeadlineAt);
	const runtime = { harness: HARNESS, provider: "llama.cpp (unidentified)", model: target.model };
	const base = { schemaVersion: "endo.coordinator-brief.v0" as const, projectId, runtime };
	const stages: EndoCoordinatorDiagnosticStageV1[] = [];
	const unavailable = (
		reason: EndoCoordinatorBriefRefusalV0,
		diag?: { openclawExitOk: boolean | null; wire?: ReturnType<typeof coordinatorWireV0>["trace"] },
	): EndoCoordinatorBriefResultV0 => ({
		...base,
		diagnostics: buildDiagnosticsV1({
			target,
			stages,
			openclawExitOk: diag?.openclawExitOk ?? null,
			wire: diag?.wire,
			refusal: reason,
		}),
		availability: "unavailable" as const,
		reason,
	});
	if (!ENDO_PROJECT_ID_PATTERN_V0.test(projectId)) return unavailable("malformed-selector");
	const origin = target.origin;
	if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) return unavailable("model-unavailable");
	const scratch = process.env.XDG_RUNTIME_DIR;
	if (!scratch?.startsWith("/")) return unavailable("runtime-unavailable");
	try {
		const stat = lstatSync(scratch);
		if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
			return unavailable("runtime-unavailable");
	} catch {
		return unavailable("runtime-unavailable");
	}
	if (isExternalCancellation()) return unavailable("runtime-unavailable");
	if (isDeadlineExceeded()) return unavailable("inference-timeout");
	if (options.provider !== undefined) runtime.provider = options.provider;
	else
		try {
			runtime.provider = await providerBuild(origin, options.deadlineSignal);
		} catch {
			if (isExternalCancellation()) return unavailable("runtime-unavailable");
			if (isDeadlineExceeded()) return unavailable("inference-timeout");
			return unavailable("model-unavailable");
		}
	if (isExternalCancellation()) return unavailable("runtime-unavailable");
	if (isDeadlineExceeded()) return unavailable("inference-timeout");
	stages.push("preflight");
	const status =
		options.pinnedObservation === undefined
			? await readCoordinatorBriefStatusV0(root, projectId)
			: pinnedCoordinatorBriefStatusV0(root, projectId, options.pinnedObservation);
	if (isExternalCancellation()) return unavailable("runtime-unavailable");
	if (isDeadlineExceeded()) return unavailable("inference-timeout");
	if (!status.ok) {
		if (status.reason === "project-not-registered") return unavailable("project-out-of-scope");
		if (status.reason === "output-too-large") return unavailable("status-output-too-large");
		if (status.reason === "timed-out") return unavailable("status-timeout");
		if (status.reason === "status-source-not-regular" || status.reason === "status-source-too-large")
			return unavailable(status.reason);
		return unavailable("status-unavailable");
	}
	stages.push("status-read");
	const toolOutcome = { availability: "available", status: status.view };
	const toolText = JSON.stringify(toolOutcome);
	const prompt = `${ENDO_COORDINATOR_INSTRUCTIONS_V0}\n\nProject in scope: ${projectId}.${request.question === undefined ? "" : `\nOperator asks: ${request.question}`}`;
	if (Buffer.byteLength(prompt) > target.maxPromptBytes) return unavailable("request-too-large");
	if (Buffer.byteLength(toolText) > 256 * 1024) return unavailable("status-output-too-large");
	let directory: string | undefined;
	let log: EndoCaptureLogV0 | undefined;
	let relay: EndoModelRelayV0 | undefined;
	try {
		const home = userInfo().homedir;
		const installed = options.openclaw ?? [join(home, ".local/bin/openclaw"), "/usr/bin/openclaw"].find(existsSync);
		if (installed === undefined) return unavailable("runtime-unavailable");
		const entry = realpathSync(installed);
		const packageDir = dirname(entry);
		const installedVersion = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
		if (
			!entry.endsWith("/openclaw.mjs") ||
			typeof installedVersion !== "string" ||
			!(ENDO_COORDINATOR_SUPPORTED_OPENCLAW_VERSIONS_V0 as readonly string[]).includes(installedVersion)
		)
			return unavailable("runtime-unavailable");
		runtime.harness = `OpenClaw ${installedVersion}`;
		directory = mkdtempSync(join(scratch, "brief-"));
		const agent = join(directory, "agent");
		mkdirSync(agent, { mode: 0o700 });
		const bearer = randomBytes(24).toString("hex");
		configure(agent, projectId, toolText, bearer, options.extraTool === true, target);
		writeFileSync(join(agent, "prompt"), prompt, { mode: 0o600 });
		const abort = new AbortController();
		log = new EndoCaptureLogV0(directory, endoDigestKeyV0(randomBytes(32), "coordinator"), "coordinator");
		const started_ = await startCoordinatorModelRelayV0({
			target,
			projectId,
			toolText,
			bearer,
			runtimeDirectory: directory,
			log,
			onRefused: () => abort.abort(),
		});
		relay = started_.relay;
		stages.push("relay-started");
		if (isExternalCancellation()) return unavailable("runtime-unavailable");
		if (isDeadlineExceeded()) return unavailable("inference-timeout");
		const remainingHostMs =
			hostDeadlineAt === null ? target.timeoutMs : Math.floor(hostDeadlineAt - performance.now());
		if (hostDeadlineAt !== null && remainingHostMs <= 0) return unavailable("inference-timeout");
		const execTimeoutMs = hostDeadlineAt === null ? target.timeoutMs : Math.max(1, remainingHostMs);
		const wire: ReturnType<typeof coordinatorWireV0> = started_.wire;
		const mounts = modelRelayMountsV0(relay, directory);
		const args = coordinatorBwrapV0(
			[
				"--ro-bind",
				packageDir,
				"/opt/openclaw",
				"--bind",
				agent,
				SCRATCH,
				...mounts.flatMap(({ source, target }) => ["--ro-bind", source, target]),
				"--setenv",
				"HOME",
				`${SCRATCH}/home`,
				"--setenv",
				"OPENCLAW_HOME",
				`${SCRATCH}/home`,
				"--setenv",
				"OPENCLAW_STATE_DIR",
				`${SCRATCH}/state`,
				"--setenv",
				"OPENCLAW_CONFIG_PATH",
				`${SCRATCH}/config.json`,
				"--setenv",
				"OPENCLAW_DISABLE_BONJOUR",
				"1",
				"--setenv",
				"OPENCLAW_SKIP_CHANNELS",
				"1",
			],
			bridgedCommandV0(realpathSync(process.execPath), PORT, [
				realpathSync(process.execPath),
				"/opt/openclaw/openclaw.mjs",
				"agent",
				"--local",
				"--agent",
				"coordinator",
				"--model",
				`${PROVIDER}/${target.model}`,
				"--thinking",
				"off",
				"--timeout",
				String(Math.max(1, Math.ceil(execTimeoutMs / 1000))),
				"--json",
				"--message-file",
				`${SCRATCH}/prompt`,
			]).slice(1),
			`${SCRATCH}/workspace`,
		);
		const inferenceStarted = performance.now();
		const deadline = hostDeadlineAt !== null ? AbortSignal.timeout(execTimeoutMs) : undefined;
		const signals = [
			...new Set(
				[abort.signal, options.signal, options.deadlineSignal, deadline].filter(
					(s): s is AbortSignal => s !== undefined,
				),
			),
		];
		const ran = await execute(args, signals.length === 1 ? abort.signal : AbortSignal.any(signals), execTimeoutMs);
		const inferenceElapsedMs = Math.round(performance.now() - inferenceStarted);
		await relay.close();
		const recorderClean = relay.recordingFailures() === 0 && !existsSync(relay.socketPath);
		const dispatch = join(agent, "dispatch");
		const dispatched = existsSync(dispatch) && readFileSync(dispatch, "utf8") === "called\n";
		if (wire.trace.responses.length >= 1) stages.push("exchange-1");
		if (dispatched) stages.push("tool-dispatched");
		if (wire.trace.responses.length >= 2) stages.push("exchange-2");
		options.trial?.({
			promptSha256: sha256HexV0(prompt),
			inference: coordinatorInferenceForV0(target),
			wire: wire.trace,
			dispatched,
			toolOutcome: wire.trace.statusDelivered ? toolOutcome : null,
			evidence: status.evidence,
			latencyMs: Math.round(performance.now() - started),
			inferenceElapsedMs,
			admittedExchanges: relay.admitted(),
			recorderClean,
			stderr: ran.stderr.replaceAll(bearer, "[redacted]").slice(0, 4000),
		});
		const diag = { openclawExitOk: ran.ok, wire: wire.trace };
		const final = wire.trace.responses.at(-1);
		let refusal: EndoCoordinatorBriefRefusalV0 | null = null;
		if (isExternalCancellation()) refusal = "runtime-unavailable";
		else if (
			options.deadlineSignal?.aborted ||
			(hostDeadlineAt !== null && (deadline?.aborted || performance.now() >= hostDeadlineAt))
		)
			refusal = "inference-timeout";
		else if (wire.trace.refusal !== null) refusal = wire.trace.refusal;
		else if (!recorderClean) refusal = "runtime-unavailable";
		else if (wire.trace.responses.length === 0)
			refusal = wire.trace.inference.length > 0 ? "model-unavailable" : "runtime-unavailable";
		else if (wire.trace.responses.length < wire.trace.inference.length) refusal = "model-unavailable";
		else if (final?.finish === "length") {
			// Distinguish completion-budget exhaustion inside reasoning from generic truncation (F6/S2-LIVE-002).
			// Strictly gated on finish_reason === "length" so finish_reason === "stop" preserves exact M0/M1 semantics.
			refusal = final.sawReasoning && !final.sawVisibleContent ? "reasoning-budget-exhausted" : "generation-limit";
		} else if (!ran.ok) refusal = "runtime-unavailable";
		else if (!dispatched || !wire.trace.statusDelivered) refusal = "ungrounded";
		else if (final?.finish !== "stop" || !final.text.trim()) refusal = "ungrounded";
		else if (Buffer.byteLength(final.text.trim(), "utf8") > 4096) refusal = "generation-limit";
		else {
			const unsupported = coordinatorAnswerRefusalV0(final.text, status.view);
			if (unsupported !== null) refusal = unsupported;
		}
		if (refusal !== null) return unavailable(refusal, diag);
		stages.push("validated");
		return {
			...base,
			diagnostics: buildDiagnosticsV1({
				target,
				stages,
				openclawExitOk: ran.ok,
				wire: wire.trace,
				refusal: null,
			}),
			availability: "available",
			answer: final!.text.trim(),
			evidence: status.evidence,
			toolSurface: [ENDO_COORDINATOR_TOOL_V0],
		};
	} catch {
		if (isExternalCancellation()) return unavailable("runtime-unavailable");
		if (isDeadlineExceeded()) return unavailable("inference-timeout");
		return unavailable("runtime-unavailable");
	} finally {
		try {
			await relay?.close();
		} finally {
			log?.close();
			if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
		}
	}
}

export type OpenClawCoordinatorPreflightResultV0 =
	| { readonly ok: true; readonly harness: string }
	| { readonly ok: false; readonly reason: EndoCoordinatorBriefRefusalV0; readonly detail: string };

/**
 * Deterministic local non-inference preflight for the sandboxed OpenClaw runner (COORDINATOR-GROUNDING-002 §6).
 * Performs zero network I/O, spawns zero subprocesses, and contacts no model endpoint.
 * Intended to run BEFORE S2 Phase E links `turns/<id>.dispatched.json` so a local runtime mismatch
 * (unsupported OpenClaw version, unsafe XDG_RUNTIME_DIR, missing bwrap, oversized prompt/status)
 * refuses as `not-dispatched` with 0 token charge. `runOpenClawCoordinatorV0` still re-checks every
 * condition at execution time to remain safe against TOCTOU changes.
 */
export function preflightOpenClawCoordinatorV0(
	root: string,
	request: EndoCoordinatorBriefRequestV0,
	options: {
		readonly openclaw?: string;
		/** Optional override for the bwrap executable path checked during preflight (tests only; defaults to `/usr/bin/bwrap`). */
		readonly bwrap?: string;
		readonly target?: EndoCoordinatorModelTargetV0;
		readonly origin?: string;
		readonly pinnedObservation?: {
			readonly status: EndoCoordinatorStatusV0;
			readonly coordination: EndoCoordinatorCoordinationV0;
		};
	} = {},
): OpenClawCoordinatorPreflightResultV0 {
	const { projectId } = request;
	if (!ENDO_PROJECT_ID_PATTERN_V0.test(projectId))
		return { ok: false, reason: "malformed-selector", detail: "malformed project selector" };
	const target: EndoCoordinatorModelTargetV0 = Object.freeze({
		...(options.target ?? ENDO_COORDINATOR_M0_TARGET_V0),
		...(options.origin === undefined ? {} : { origin: options.origin }),
	});
	if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(target.origin))
		return { ok: false, reason: "model-unavailable", detail: "non-loopback target origin" };
	const scratch = process.env.XDG_RUNTIME_DIR;
	if (!scratch?.startsWith("/"))
		return { ok: false, reason: "runtime-unavailable", detail: "XDG_RUNTIME_DIR unset or relative" };
	try {
		const stat = lstatSync(scratch);
		if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
			return { ok: false, reason: "runtime-unavailable", detail: "XDG_RUNTIME_DIR ownership or mode unsafe" };
	} catch {
		return { ok: false, reason: "runtime-unavailable", detail: "XDG_RUNTIME_DIR unreadable" };
	}
	const bwrapPath = options.bwrap ?? "/usr/bin/bwrap";
	if (!bwrapPath.startsWith("/"))
		return { ok: false, reason: "runtime-unavailable", detail: "bwrap path must be absolute" };
	try {
		const bwrapStat = statSync(bwrapPath);
		if (!bwrapStat.isFile())
			return { ok: false, reason: "runtime-unavailable", detail: `${bwrapPath} not a regular file` };
		accessSync(bwrapPath, constants.X_OK);
	} catch {
		return { ok: false, reason: "runtime-unavailable", detail: `${bwrapPath} unavailable or not executable` };
	}
	let harness: string;
	try {
		const home = userInfo().homedir;
		const installed = options.openclaw ?? [join(home, ".local/bin/openclaw"), "/usr/bin/openclaw"].find(existsSync);
		if (installed === undefined)
			return { ok: false, reason: "runtime-unavailable", detail: "OpenClaw executable not found" };
		const entry = realpathSync(installed);
		const packageDir = dirname(entry);
		const installedVersion = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
		if (
			!entry.endsWith("/openclaw.mjs") ||
			typeof installedVersion !== "string" ||
			!(ENDO_COORDINATOR_SUPPORTED_OPENCLAW_VERSIONS_V0 as readonly string[]).includes(installedVersion)
		)
			return {
				ok: false,
				reason: "runtime-unavailable",
				detail: `unsupported OpenClaw version: ${String(installedVersion ?? "unknown")}`,
			};
		harness = `OpenClaw ${installedVersion}`;
	} catch {
		return { ok: false, reason: "runtime-unavailable", detail: "OpenClaw installation unreadable" };
	}
	const prompt = `${ENDO_COORDINATOR_INSTRUCTIONS_V0}\n\nProject in scope: ${projectId}.${request.question === undefined ? "" : `\nOperator asks: ${request.question}`}`;
	if (Buffer.byteLength(prompt) > target.maxPromptBytes)
		return { ok: false, reason: "request-too-large", detail: "briefing prompt exceeds maxPromptBytes" };
	if (options.pinnedObservation !== undefined) {
		const pinned = pinnedCoordinatorBriefStatusV0(root, projectId, options.pinnedObservation);
		if (!pinned.ok) return { ok: false, reason: "status-unavailable", detail: pinned.reason };
		const toolText = JSON.stringify({ availability: "available", status: pinned.view });
		if (Buffer.byteLength(toolText) > 256 * 1024)
			return { ok: false, reason: "status-output-too-large", detail: "status view exceeds 256 KiB ceiling" };
	}
	return { ok: true, harness };
}

export function openClawCoordinatorV0(root: string): EndoCoordinatorBriefSubstrateV0 {
	return { brief: (request) => runOpenClawCoordinatorV0(root, request) };
}
