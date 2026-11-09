// EVAL-ISO-003 example (docs/protected-model-access.md §9): a Pi condition for `endo experiment protected-run` with a model-connected
// (version 1) spec. The production runner knows nothing of Pi: it mounts the condition's agent directory read-only at /agent, runs its
// argv behind the bridge, and tells it, by environment only, where the model is (ENDO_MODEL_ORIGIN), which model (ENDO_MODEL_ID) and the
// generation bound every request must state (ENDO_MODEL_MAX_COMPLETION_TOKENS). Everything Pi-specific is here, inside the agent directory:
// a copy of Pi's `dist` (digested with the rest of the directory), a launcher that writes Pi's configuration into its private HOME, and the
// prompt.
//
//   node research/protected-eval/model-connected/pi-condition.ts --pi-dist <Pi's dist> --agent-out <new dir> --model <id> \
//        [--upstream http://127.0.0.1:8081] [--max-completion-tokens 2048] [--max-exchanges 40] > <spec.json>
//
// The task is the offline example's (research/protected-eval/example/: mergeIntervals, its evaluator with a reference and a negative).

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The launcher, run as `/usr/bin/node /agent/launch.mjs` in /work. It writes Pi's models.json and settings.json into a directory in its
 * private HOME (a tmpfs; /agent is read-only), naming the relay's bridge and the declared model, with `maxTokens` at the declared bound so
 * that every request Pi sends states it (Pi 1.5.0 sends it as `max_completion_tokens`). It then runs Pi once with the prompt, passing on
 * termination signals, and exits with Pi's status.
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
const child = spawn("/usr/bin/node", ["/agent/pi/dist/bundle/cli.js", "-p", "--no-session", prompt], {
	stdio: "inherit",
	env: { ...env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(127));
child.on("exit", (code) => process.exit(code ?? 1));
`;

export const PI_PROMPT_V1 =
	"Read README.md in the current directory and complete the task it describes. Write the implementation to the file it names.";

/** The executables Pi's tools need here, and `sh` (Pi's bash tool runs `sh -c`; the host's is a link, so bash is mounted there too). */
export const PI_RUNTIME_V1 = {
	executables: ["/usr/bin/node", "/usr/bin/bash", "/usr/bin/cat", "/usr/bin/head", "/usr/bin/ls", "/usr/bin/grep"],
	aliases: [{ target: "/usr/bin/sh", executable: "/usr/bin/bash" }],
};

/** Make a Pi condition's agent directory at `out` (new): the launcher, the prompt, and a copy of Pi's dist. */
export function makePiAgentDirectoryV1(piDist: string, out: string, prompt = PI_PROMPT_V1): void {
	if (existsSync(out)) throw new TypeError(`${out} exists: the agent directory is made new`);
	mkdirSync(out, { recursive: true, mode: 0o700 });
	writeFileSync(join(out, "launch.mjs"), PI_LAUNCHER_SOURCE_V1, { mode: 0o644 });
	writeFileSync(join(out, "prompt.txt"), prompt, { mode: 0o644 });
	mkdirSync(join(out, "pi"), { mode: 0o755 });
	// A copy, never a link: the runner refuses links in an agent directory, and digests what it mounts.
	cpSync(realpathSync(piDist), join(out, "pi", "dist"), { recursive: true, dereference: false });
}

/** The example's spec (version 1) for one Pi condition against one model. */
export function piExampleSpecV1(options: {
	agentDirectory: string;
	upstream: string;
	model: string;
	maxCompletionTokens?: number;
	maxExchanges?: number;
	trials?: number;
}): Record<string, unknown> {
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
		runtime: PI_RUNTIME_V1,
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
	const flag = (name: string, fallback?: string) => {
		const i = args.indexOf(name);
		const v = i === -1 ? fallback : args[i + 1];
		if (v === undefined) throw new TypeError(`${name} is required`);
		return v;
	};
	const agentOut = resolve(flag("--agent-out"));
	makePiAgentDirectoryV1(flag("--pi-dist"), agentOut);
	const spec = piExampleSpecV1({
		agentDirectory: agentOut,
		upstream: flag("--upstream", "http://127.0.0.1:8081"),
		model: flag("--model"),
		maxCompletionTokens: Number(flag("--max-completion-tokens", "2048")),
		maxExchanges: Number(flag("--max-exchanges", "40")),
	});
	process.stdout.write(`${JSON.stringify(spec, null, "\t")}\n`);
}
