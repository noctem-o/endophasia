// EVAL-ISO-003 example (docs/protected-model-access.md §9): a Pi condition for `endo experiment protected-run` with a model-connected
// (version 1 or 3) spec. The production runner knows nothing of Pi: it mounts the condition's agent directory read-only at /agent, runs
// its argv behind the bridge, and tells it, by environment only, where the model is (ENDO_MODEL_ORIGIN), which model (ENDO_MODEL_ID) and
// the generation bound every request must state (ENDO_MODEL_MAX_COMPLETION_TOKENS). Everything Pi-specific is here, inside the agent
// directory: a copy of Pi's `dist` (digested with the rest of the directory), a launcher that writes Pi's configuration into its private
// HOME, and the prompt.
//
// Opt-in capability-consistent initial prompting (PI-RUNTIME-CONSISTENCY-001): when `capabilityConsistentPrompt: true` (or CLI flag
// `--capability-consistent-prompt`) is explicitly selected, the controller derives `/agent/system-prompt.txt` and its pin manifest
// `/agent/runtime-prompt.json` strictly from the enforced `runtime` specification via `adapters/sandbox/runtime-prompt.ts`, pins both
// inside the read-only `/agent` tree digest, verifies them against `spec.runtime` before spec generation, and checks `/usr/bin` against
// the pin inside the sandbox before spawning Pi. Existing non-opt-in launches remain byte-for-byte unchanged.
//
//   node research/protected-eval/model-connected/pi-condition.ts --pi-dist <Pi's dist> --agent-out <new dir> --model <id> \
//        [--upstream http://127.0.0.1:8081] [--max-completion-tokens 2048] [--max-exchanges 40] \
//        [--capability-consistent-prompt] > <spec.json>
//
// The task is the offline example's (research/protected-eval/example/: mergeIntervals, its evaluator with a reference and a negative).

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildRuntimeCapabilityPromptV0,
	type EndoPiToolV0,
	EndoRuntimePromptErrorV0,
	type EndoSandboxRuntimeSpecV0,
	verifyRuntimeCapabilityPromptPinV0,
} from "../../../adapters/sandbox/runtime-prompt.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";

/**
 * The default launcher, run as `/usr/bin/node /agent/launch.mjs` in /work. It writes Pi's models.json and settings.json into a directory in
 * its private HOME (a tmpfs; /agent is read-only), naming the relay's bridge and the declared model, with `maxTokens` at the declared bound
 * so that every request Pi sends states it (Pi 1.5.0+ sends it as `max_completion_tokens`). It then runs Pi once with the prompt, passing
 * on termination signals, and exits with Pi's status.
 */
export const PI_LAUNCHER_SOURCE_V1 = `import { spawn } from "node:child_process";
import fs from "node:fs";
const env = process.env;
const dir = env.HOME + "/.pi-agent";
fs.mkdirSync(dir, { recursive: true });
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
fs.writeFileSync(dir + "/models.json", JSON.stringify({ providers: { relay: { baseUrl: env.ENDO_MODEL_ORIGIN + "/v1",
	api: "openai-completions", apiKey: "local", models: [{ id: env.ENDO_MODEL_ID, contextWindow: 32768,
	maxTokens: Number(env.ENDO_MODEL_MAX_COMPLETION_TOKENS), input: ["text"], cost: zero }] } } }));
fs.writeFileSync(dir + "/settings.json", JSON.stringify({ defaultProvider: "relay", defaultModel: env.ENDO_MODEL_ID }));
const prompt = fs.readFileSync("/agent/prompt.txt", "utf8");
const flags = process.argv.slice(2);
if (flags.length && (flags.length !== 1 || flags[0] !== "--read-edit-pilot")) throw new Error("unknown condition");
const pilot = flags.length ? ["--mode", "json", "--tools", "read,edit", "--offline", "--no-extensions", "--no-mcp",
	"--no-skills", "--no-context-files", "--no-prompt-templates", "--no-approve", "--thinking", "off"] : [];
const child = spawn("/usr/bin/node", ["/agent/pi/dist/bundle/cli.js", "-p", "--no-session", ...pilot, prompt], {
	stdio: "inherit",
	env: { ...env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(127));
child.on("exit", (code) => process.exit(code ?? 1));
`;

/**
 * Opt-in capability-consistent launcher (PI-RUNTIME-CONSISTENCY-001). Before spawning Pi (and before any model exchange), it fails closed
 * unless:
 *  1. `/agent/runtime-prompt.json` and `/agent/system-prompt.txt` are present and digest-consistent;
 *  2. `process.cwd()` equals `pin.cwd`;
 *  3. `/usr/bin` inside the sandbox matches `pin.mountedExecutables ∪ pin.mountedAliases` exactly.
 * It then spawns Pi with `--system-prompt /agent/system-prompt.txt`, explicit `--tools <pin.piTools>`, and `--no-approve --no-context-files
 * --no-extensions --no-mcp --no-skills --no-prompt-templates --offline`, so agent-controlled files in `/work` cannot override the prompt.
 */
export function piCapabilityConsistentLauncherSourceV1(contextWindow = 32768): string {
	if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024) {
		throw new EndoRuntimePromptErrorV0("invalid-context-window", "contextWindow must be an integer >= 1024");
	}
	return `import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
const env = process.env;
const flags = process.argv.slice(2);
if (flags.length > 0) throw new Error("unknown launcher arguments");
const pin = JSON.parse(fs.readFileSync("/agent/runtime-prompt.json", "utf8"));
if (
	!pin ||
	pin.schemaVersion !== "endo.pi-runtime-prompt.v0" ||
	!Array.isArray(pin.piTools) ||
	pin.piTools.length === 0 ||
	!Array.isArray(pin.mountedExecutables) ||
	!Array.isArray(pin.mountedAliases)
) {
	throw new Error("invalid runtime-prompt.json");
}
const sysPrompt = fs.readFileSync("/agent/system-prompt.txt", "utf8");
const sysSha = createHash("sha256").update(sysPrompt, "utf8").digest("hex");
if (sysSha !== pin.systemPromptBodySha256) throw new Error("system-prompt.txt digest mismatch");
if (process.cwd() !== pin.cwd) throw new Error("sandbox cwd does not match pinned runtime prompt cwd");
const expectedBin = [...pin.mountedExecutables, ...pin.mountedAliases.map((a) => a.alias)].sort();
const actualBin = fs.readdirSync("/usr/bin").sort();
if (JSON.stringify(actualBin) !== JSON.stringify(expectedBin)) {
	throw new Error("sandbox /usr/bin mismatch: expected [" + expectedBin.join(",") + "] got [" + actualBin.join(",") + "]");
}
for (const a of pin.mountedAliases) {
	const aliasStat = fs.statSync("/usr/bin/" + a.alias);
	const targetStat = fs.statSync("/usr/bin/" + a.targetExecutable);
	if (aliasStat.dev !== targetStat.dev || aliasStat.ino !== targetStat.ino) {
		throw new Error("sandbox alias mismatch: /usr/bin/" + a.alias + " does not match /usr/bin/" + a.targetExecutable);
	}
}
const dir = env.HOME + "/.pi-agent";
fs.mkdirSync(dir, { recursive: true });
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
fs.writeFileSync(dir + "/models.json", JSON.stringify({ providers: { relay: { baseUrl: env.ENDO_MODEL_ORIGIN + "/v1",
	api: "openai-completions", apiKey: "local", models: [{ id: env.ENDO_MODEL_ID, contextWindow: ${contextWindow},
	maxTokens: Number(env.ENDO_MODEL_MAX_COMPLETION_TOKENS), input: ["text"], cost: zero }] } } }));
fs.writeFileSync(dir + "/settings.json", JSON.stringify({ defaultProvider: "relay", defaultModel: env.ENDO_MODEL_ID }));
const prompt = fs.readFileSync("/agent/prompt.txt", "utf8");
const child = spawn("/usr/bin/node", [
	"/agent/pi/dist/bundle/cli.js",
	"-p",
	"--no-session",
	"--offline",
	"--no-extensions",
	"--no-mcp",
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-approve",
	"--tools",
	pin.piTools.join(","),
	"--system-prompt",
	"/agent/system-prompt.txt",
	prompt,
], {
	stdio: "inherit",
	env: { ...env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(127));
child.on("exit", (code) => process.exit(code ?? 1));
`;
}

export const PI_CAPABILITY_CONSISTENT_LAUNCHER_SOURCE_V1 = piCapabilityConsistentLauncherSourceV1(32768);

export const PI_PROMPT_V1 =
	"Read README.md in the current directory and complete the task it describes. Write the implementation to the file it names.";

/** The executables Pi's tools need here, and `sh` (Pi's bash tool runs `sh -c`; the host's is a link, so bash is mounted there too). */
export const PI_RUNTIME_V1 = {
	executables: ["/usr/bin/node", "/usr/bin/bash", "/usr/bin/cat", "/usr/bin/head", "/usr/bin/ls", "/usr/bin/grep"],
	aliases: [{ target: "/usr/bin/sh", executable: "/usr/bin/bash" }],
};

export interface EndoPiAgentDirectoryOptionsV1 {
	/** Opt-in: derive and pin `/agent/system-prompt.txt` and `/agent/runtime-prompt.json` from `runtime`. Default: false. */
	capabilityConsistentPrompt?: boolean;
	/** Enforced sandbox runtime specification. Required when `capabilityConsistentPrompt` is true. */
	runtime?: EndoSandboxRuntimeSpecV0;
	/** Registered Pi tools to advertise and pass to `--tools`. Default: `["read", "bash", "edit", "write"]`. */
	piTools?: readonly EndoPiToolV0[];
	/** Sandbox working directory (default `"/work"`). */
	cwd?: string;
	/** Model context window written into Pi's `models.json` when opt-in is enabled (default `32768`). */
	contextWindow?: number;
}

/**
 * Make a Pi condition's agent directory at `out` (new): the launcher, the prompt, and a copy of Pi's dist. When
 * `options.capabilityConsistentPrompt` is true, also derives and pins `/agent/system-prompt.txt` and `/agent/runtime-prompt.json` strictly
 * from `options.runtime`, failing closed before creating `out` if the runtime cannot support an accurate capability description.
 */
export function makePiAgentDirectoryV1(
	piDist: string,
	out: string,
	prompt = PI_PROMPT_V1,
	options: EndoPiAgentDirectoryOptionsV1 = {},
): void {
	if (existsSync(out)) throw new TypeError(`${out} exists: the agent directory is made new`);
	const optIn = options.capabilityConsistentPrompt === true;
	let launcherSource = PI_LAUNCHER_SOURCE_V1;
	let derived: Extract<ReturnType<typeof buildRuntimeCapabilityPromptV0>, { ok: true }> | null = null;
	if (optIn) {
		if (!options.runtime) {
			throw new EndoRuntimePromptErrorV0(
				"missing-runtime",
				"capabilityConsistentPrompt requires an explicit enforced runtime specification",
			);
		}
		const built = buildRuntimeCapabilityPromptV0({
			runtime: options.runtime,
			piTools: options.piTools,
			cwd: options.cwd,
		});
		if (!built.ok) throw new EndoRuntimePromptErrorV0(built.reason, built.detail);
		derived = built;
		launcherSource = piCapabilityConsistentLauncherSourceV1(options.contextWindow ?? 32768);
	}
	mkdirSync(out, { recursive: true, mode: 0o700 });
	writeFileSync(join(out, "launch.mjs"), launcherSource, { mode: 0o644 });
	writeFileSync(join(out, "prompt.txt"), prompt, { mode: 0o644 });
	if (derived !== null) {
		writeFileSync(join(out, "system-prompt.txt"), derived.prompt.systemPromptBody, { mode: 0o644 });
		writeFileSync(join(out, "runtime-prompt.json"), canonicalEndoJsonV0(derived.pin), { mode: 0o644 });
	}
	mkdirSync(join(out, "pi"), { mode: 0o755 });
	// A copy, never a link: the runner refuses links in an agent directory, and digests what it mounts.
	cpSync(realpathSync(piDist), join(out, "pi", "dist"), { recursive: true, dereference: false });
}

/**
 * Controller-side pre-launch verification for an opt-in capability-consistent Pi agent directory. Verifies that
 * `runtime-prompt.json`, `system-prompt.txt`, and `launch.mjs` agree with the enforced `runtime` specification and
 * declared Pi tools, throwing `EndoRuntimePromptErrorV0` on any mismatch or missing file.
 */
export function verifyPiAgentRuntimePromptPinV1(
	agentDirectory: string,
	runtime: EndoSandboxRuntimeSpecV0,
	options: { piTools?: readonly EndoPiToolV0[]; cwd?: string; contextWindow?: number } = {},
) {
	const dir = resolve(agentDirectory);
	let pinRaw: unknown;
	let sysPrompt: string;
	let launcher: string;
	try {
		pinRaw = JSON.parse(readFileSync(join(dir, "runtime-prompt.json"), "utf8"));
	} catch {
		throw new EndoRuntimePromptErrorV0("missing-pin", `${dir}/runtime-prompt.json could not be read as JSON`);
	}
	try {
		sysPrompt = readFileSync(join(dir, "system-prompt.txt"), "utf8");
	} catch {
		throw new EndoRuntimePromptErrorV0("missing-prompt", `${dir}/system-prompt.txt could not be read`);
	}
	try {
		launcher = readFileSync(join(dir, "launch.mjs"), "utf8");
	} catch {
		throw new EndoRuntimePromptErrorV0("missing-launcher", `${dir}/launch.mjs could not be read`);
	}
	const expectedLauncher = piCapabilityConsistentLauncherSourceV1(options.contextWindow ?? 32768);
	if (launcher !== expectedLauncher) {
		throw new EndoRuntimePromptErrorV0(
			"launcher-mismatch",
			`${dir}/launch.mjs is not the governed capability-consistent launcher`,
		);
	}
	const verified = verifyRuntimeCapabilityPromptPinV0({
		runtime,
		piTools: options.piTools,
		cwd: options.cwd,
		pin: pinRaw,
		systemPromptBody: sysPrompt,
	});
	if (!verified.ok) throw new EndoRuntimePromptErrorV0(verified.reason, verified.detail);
	return verified;
}

/** The example's spec (version 1) for one Pi condition against one model. */
export function piExampleSpecV1(options: {
	agentDirectory: string;
	upstream: string;
	model: string;
	maxCompletionTokens?: number;
	maxExchanges?: number;
	trials?: number;
	runtime?: EndoSandboxRuntimeSpecV0;
	capabilityConsistentPrompt?: boolean;
	piTools?: readonly EndoPiToolV0[];
	cwd?: string;
	contextWindow?: number;
}): Record<string, unknown> {
	const runtime = options.runtime ?? PI_RUNTIME_V1;
	if (options.capabilityConsistentPrompt === true) {
		verifyPiAgentRuntimePromptPinV1(options.agentDirectory, runtime, {
			piTools: options.piTools,
			cwd: options.cwd,
			contextWindow: options.contextWindow,
		});
	}
	const example = fileURLToPath(new URL("../example/", import.meta.url));
	const evaluator = join(example, "evaluator", "evaluator.json");
	return {
		schemaVersion: "endo.protected-experiment-spec.v1",
		id: "endo.experiment.protected-pi-model-example",
		description:
			"EVAL-ISO-003 example: Pi with one local model, through the recording relay, on the offline example's task.",
		seed: 20261109,
		trials: options.trials ?? 1,
		limits: {
			agentTimeoutMs: 600_000,
			evaluationTimeoutMs: 30_000,
			outputBytes: 4 * 1024 * 1024,
			tmpfsBytes: 64 * 1024 * 1024,
			maxFileBytes: 65_536,
			maxTotalBytes: 262_144,
			memoryMaxBytes: 2 * 1024 * 1024 * 1024,
			cpuQuotaPercent: 400,
		},
		runtime,
		tasks: [
			{
				id: "merge-intervals",
				workspace: {
					"README.md":
						"Implement mergeIntervals(list) in src/interval.mjs: merge overlapping or touching [start, end] pairs, and return them sorted by start.\n",
					"src/interval.mjs": 'export function mergeIntervals(list) {\n\tthrow new Error("not implemented");\n}\n',
				},
				submission: ["src/interval.mjs"],
				evaluator: { file: evaluator, sha256: createHash("sha256").update(readFileSync(evaluator)).digest("hex") },
			},
		],
		conditions: [
			{
				id: "pi",
				description: "Pi, with the declared model through the relay",
				agent: { directory: resolve(options.agentDirectory), argv: ["/usr/bin/node", "/agent/launch.mjs"] },
			},
		],
		modelAccess: {
			upstream: options.upstream,
			model: options.model,
			// Measured: Pi 1.5.0 with an openai-completions provider uses only this route (docs/protected-model-access.md §2).
			routes: [{ method: "POST", path: "/v1/chat/completions" }],
			maxRequestBytes: 1024 * 1024,
			maxTransferredBytes: 256 * 1024 * 1024,
			maxConnections: 8,
			maxTotalConnections: 1024,
			maxExchanges: options.maxExchanges ?? 40,
			maxCompletionTokens: options.maxCompletionTokens ?? 2048,
			minExchanges: 1,
		},
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const hasFlag = (name: string) => args.includes(name);
	const flag = (name: string, fallback?: string) => {
		const i = args.indexOf(name);
		const v = i === -1 ? fallback : args[i + 1];
		if (v === undefined) throw new TypeError(`${name} is required`);
		return v;
	};
	const agentOut = resolve(flag("--agent-out"));
	const capabilityConsistentPrompt = hasFlag("--capability-consistent-prompt");
	makePiAgentDirectoryV1(
		flag("--pi-dist"),
		agentOut,
		PI_PROMPT_V1,
		capabilityConsistentPrompt ? { capabilityConsistentPrompt: true, runtime: PI_RUNTIME_V1 } : {},
	);
	const spec = piExampleSpecV1({
		agentDirectory: agentOut,
		upstream: flag("--upstream", "http://127.0.0.1:8081"),
		model: flag("--model"),
		maxCompletionTokens: Number(flag("--max-completion-tokens", "2048")),
		maxExchanges: Number(flag("--max-exchanges", "40")),
		capabilityConsistentPrompt,
	});
	process.stdout.write(`${JSON.stringify(spec, null, "\t")}\n`);
}
