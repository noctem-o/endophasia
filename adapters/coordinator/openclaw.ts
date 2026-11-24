import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { get, type IncomingMessage } from "node:http";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "../../protocol/develop-tasks.ts";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	ENDO_COORDINATOR_INSTRUCTIONS_V0,
	ENDO_COORDINATOR_TOOL_DEFINITION_V0,
	ENDO_COORDINATOR_TOOL_V0,
	type EndoCoordinatorBriefRefusalV0,
	type EndoCoordinatorBriefRequestV0,
	type EndoCoordinatorBriefResultV0,
	type EndoCoordinatorBriefSubstrateV0,
} from "../../runtime/contracts/coordinator-brief.ts";
import { endoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { EndoCaptureLogV0 } from "../openai-proxy/capture-log.ts";
import {
	bridgedCommandV0,
	type EndoModelRelayV0,
	modelRelayMountsV0,
	startModelRelayV0,
} from "../sandbox/model-relay.ts";
import {
	COORDINATOR_ENV_V0,
	coordinatorAnswerRefusalV0,
	coordinatorBwrapV0,
	readCoordinatorBriefStatusV0,
} from "./status.ts";
import { COORDINATOR_INFERENCE_V0, coordinatorWireV0 } from "./wire.ts";

const HARNESS = "OpenClaw 2026.11.7";
const MODEL = "Inkling-2-Mini-Uncensored-AD-Q4_K";
const ORIGIN = "http://127.0.0.1:8091";
const ROUTE = "/v1/chat/completions";
const PROVIDER = "endo-local";
const PORT = 18091;
const PLUGIN = "endo-coordinator";
const SCRATCH = "/scratch";
function pluginEntry(projectId: string, toolText: string) {
	return `import { appendFileSync } from "node:fs";
const project = ${JSON.stringify(projectId)};
const tool = ${JSON.stringify({ ...ENDO_COORDINATOR_TOOL_DEFINITION_V0, label: "Endophasia Status" })};
const status = ${JSON.stringify(toolText)};
const settings = ${JSON.stringify(COORDINATOR_INFERENCE_V0)};
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
          delete next.max_completion_tokens;
          Object.assign(next, settings);
          return next;
        }
      });
    }
  });
}};`;
}

const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

function configure(directory: string, projectId: string, toolText: string, bearer: string, extraTool: boolean) {
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
	writeFileSync(join(directory, "plugin", "index.mjs"), pluginEntry(projectId, toolText), { mode: 0o600 });
	const modelRef = `${PROVIDER}/${MODEL}`;
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
							id: MODEL,
							name: MODEL,
							input: ["text"],
							reasoning: false,
							contextWindow: 32_768,
							maxTokens: COORDINATOR_INFERENCE_V0.max_tokens,
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

const execute = (args: string[], signal: AbortSignal) =>
	new Promise<{ ok: boolean; stderr: string }>((resolve) => {
		execFile(
			"/usr/bin/bwrap",
			args,
			{
				env: COORDINATOR_ENV_V0,
				timeout: 155_000,
				killSignal: "SIGKILL",
				maxBuffer: 512 * 1024,
				signal,
			},
			(error, _stdout, stderr) => resolve({ ok: error === null, stderr }),
		);
	});

async function providerBuild(origin: string) {
	const signal = AbortSignal.timeout(3000);
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
	readonly inference: typeof COORDINATOR_INFERENCE_V0;
	readonly wire: ReturnType<typeof coordinatorWireV0>["trace"];
	readonly dispatched: boolean;
	readonly toolOutcome: unknown;
	readonly evidence: Extract<EndoCoordinatorBriefResultV0, { availability: "available" }>["evidence"];
	readonly latencyMs: number;
	readonly recorderClean: boolean;
	readonly stderr: string;
}

export async function runOpenClawCoordinatorV0(
	root: string,
	request: EndoCoordinatorBriefRequestV0,
	options: {
		openclaw?: string;
		origin?: string;
		extraTool?: boolean;
		trial?: (trial: OpenClawCoordinatorTrialV0) => void;
	} = {},
): Promise<EndoCoordinatorBriefResultV0> {
	const { projectId } = request;
	const runtime = { harness: HARNESS, provider: "llama.cpp (unidentified)", model: MODEL };
	const base = { schemaVersion: "endo.coordinator-brief.v0" as const, projectId, runtime };
	const unavailable = (reason: EndoCoordinatorBriefRefusalV0) => ({
		...base,
		availability: "unavailable" as const,
		reason,
	});
	if (!ENDO_PROJECT_ID_PATTERN_V0.test(projectId)) return unavailable("malformed-selector");
	const origin = options.origin ?? ORIGIN;
	if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) return unavailable("model-unavailable");
	try {
		runtime.provider = await providerBuild(origin);
	} catch {
		return unavailable("model-unavailable");
	}
	const started = performance.now();
	const status = await readCoordinatorBriefStatusV0(root, projectId);
	if (!status.ok) {
		if (status.reason === "project-not-registered") return unavailable("project-out-of-scope");
		if (status.reason === "output-too-large") return unavailable("status-output-too-large");
		if (status.reason === "timed-out") return unavailable("status-timeout");
		return unavailable("status-unavailable");
	}
	const toolOutcome = { availability: "available", status: status.view };
	const toolText = JSON.stringify(toolOutcome);
	const prompt = `${ENDO_COORDINATOR_INSTRUCTIONS_V0}\n\nProject in scope: ${projectId}.${request.question === undefined ? "" : `\nOperator asks: ${request.question}`}`;
	if (Buffer.byteLength(prompt) > 8192) return unavailable("request-too-large");
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
		if (
			!entry.endsWith("/openclaw.mjs") ||
			JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version !== "2026.11.7"
		)
			return unavailable("runtime-unavailable");
		const scratch = join(home, ".capy/work");
		mkdirSync(scratch, { recursive: true, mode: 0o700 });
		directory = mkdtempSync(join(scratch, "brief-"));
		const agent = join(directory, "agent");
		mkdirSync(agent, { mode: 0o700 });
		const bearer = randomBytes(24).toString("hex");
		configure(agent, projectId, toolText, bearer, options.extraTool === true);
		writeFileSync(join(agent, "prompt"), prompt, { mode: 0o600 });
		const abort = new AbortController();
		const wire = coordinatorWireV0(projectId, toolText, bearer, () => abort.abort());
		log = new EndoCaptureLogV0(directory, endoDigestKeyV0(randomBytes(32), "coordinator"), "coordinator");
		relay = await startModelRelayV0({
			upstream: origin,
			log,
			runtimeDirectory: directory,
			policy: {
				routes: [{ method: "POST", path: ROUTE }],
				model: MODEL,
				maxRequestBytes: 512 * 1024,
				maxTransferredBytes: 8 * 1024 * 1024,
				maxConnections: 4,
				maxTotalConnections: 8,
				maxExchanges: 2,
				maxCompletionTokens: COORDINATOR_INFERENCE_V0.max_tokens,
			},
			additionalAdmission: { request: wire.request, response: wire.response },
		});
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
				`${PROVIDER}/${MODEL}`,
				"--thinking",
				"off",
				"--timeout",
				"135",
				"--json",
				"--message-file",
				`${SCRATCH}/prompt`,
			]).slice(1),
			`${SCRATCH}/workspace`,
		);
		const ran = await execute(args, abort.signal);
		await relay.close();
		const recorderClean = relay.recordingFailures() === 0 && !existsSync(relay.socketPath);
		const dispatch = join(agent, "dispatch");
		const dispatched = existsSync(dispatch) && readFileSync(dispatch, "utf8") === "called\n";
		options.trial?.({
			promptSha256: sha256HexV0(prompt),
			inference: COORDINATOR_INFERENCE_V0,
			wire: wire.trace,
			dispatched,
			toolOutcome: wire.trace.statusDelivered ? toolOutcome : null,
			evidence: status.evidence,
			latencyMs: Math.round(performance.now() - started),
			recorderClean,
			stderr: ran.stderr.replaceAll(bearer, "[redacted]").slice(0, 4000),
		});
		if (wire.trace.refusal !== null) return unavailable(wire.trace.refusal);
		if (!recorderClean) return unavailable("runtime-unavailable");
		if (wire.trace.responses.length === 0)
			return unavailable(wire.trace.inference.length > 0 ? "model-unavailable" : "runtime-unavailable");
		if (!ran.ok) return unavailable("runtime-unavailable");
		const final = wire.trace.responses.at(-1);
		if (!dispatched || !wire.trace.statusDelivered) return unavailable("ungrounded");
		if (final?.finish === "length") return unavailable("generation-limit");
		if (final?.finish !== "stop" || !final.text.trim()) return unavailable("ungrounded");
		const unsupported = coordinatorAnswerRefusalV0(final.text, status.view);
		if (unsupported !== null) return unavailable(unsupported);
		return {
			...base,
			availability: "available",
			answer: final.text.trim(),
			evidence: status.evidence,
			toolSurface: [ENDO_COORDINATOR_TOOL_V0],
		};
	} catch {
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

export function openClawCoordinatorV0(root: string): EndoCoordinatorBriefSubstrateV0 {
	return { brief: (request) => runOpenClawCoordinatorV0(root, request) };
}
