// Re-runs the study's real-runtime scenarios against a DSH SOURCE checkout, in a throwaway home, and leaves the raw captures where
// build-fixtures.ts reads them. It never touches the user's DSH home, process or profiles, and starts no server:
//
// - DSH_HOME and HOME point into the output directory, so the user's ~/.dsh (profiles, credentials, sessions) is not read or written;
// - the child gets an EMPTY environment plus the few variables it needs (env -i semantics), so no API key, proxy or .env value of the
//   caller reaches it, and a placeholder key stands in for the keyless local server;
// - everything that could reach a network other than the one configured model route is disabled in the profile patch (DeepSeek
//   routes and account, session-log upload, package inventory, telemetry, web tools), the permission mode is read-only, and tools
//   that run commands or spawn agents are disabled;
// - a passive observer plugin (instruments/observer.mjs) only LISTENS to session/event, session/flush, agent/status and
//   agent/assistant-stream; the stub provider (instruments/stub-provider.mjs) replaces only the model for the retry case.
//
//   node research/dsh-native/reproduce.ts --dsh <checkout> --out <dir> [--scenario stub-retry|tool-read|no-key-error|crash] [--model-url http://127.0.0.1:8080]
//
// The scenarios that call a model need that server to be running; `stub-retry` needs no model and is the one the opt-in test runs.

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Profile rows that could reach a network or run arbitrary commands. The local model route is the only egress left. */
export const DISABLED_ROWS = [
	"session-log-deepseek",
	"plugin-package-inventory-deepseek",
	"session-title-llm",
	"session-telemetry-otel",
	"otel",
	"llm-deepseek",
	"llm-deepseek-account",
	"deepseek-account",
	"web",
	"web-search-deepseek",
	"web-deepseek-api",
	"web-fetch-http",
	"tool-web",
	"tool-bash",
	"tool-pwsh",
	"tool-jobs",
	"tool-skill",
	"tool-subagent-control",
	"tool-subagent-list-agents",
	"tool-subagent",
	"tool-subagent-fork",
	"subagent",
	"subagent-spawn-in-process",
	"subagent-fork-in-process",
	// Surfaces that can fetch code, accept connections or reach other servers; the run needs none of them.
	"plugin-manager",
	"typert-gateway",
	"remote-access",
	"mcp-resources",
	"tool-workflow",
	"tool-todo",
	"tool-goal",
] as const;

export const SCENARIOS = ["stub-retry", "tool-read", "no-key-error", "crash"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface ReproduceOptions {
	dsh: string;
	out: string;
	scenario: Scenario;
	modelUrl?: string;
}

const PROMPTS: Record<Scenario, string> = {
	"stub-retry": "hello",
	"tool-read":
		"Use the read tool to read the file notes.txt in the current directory, then reply with only the number of lines it contains.",
	"no-key-error":
		"Use the read tool to read the file notes.txt in the current directory, then reply with only the number of lines it contains.",
	crash: "Without using any tools, write the integers from 1 to 400 separated by commas, then stop.",
};

export function profilePatch(options: { home: string; stub: boolean; modelUrl: string; keyed: boolean }): string {
	const rows = DISABLED_ROWS.map((id) => `- id: ${id}\n  disabled: true`).join("\n");
	const model = options.stub
		? `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-v4-flash`
		: `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      local:
        displayName: Local model (study scratch)
        api: openai-completions
        baseURL: ${options.modelUrl}
${options.keyed ? "        apiKeyEnv: STUDY_PLACEHOLDER_KEY\n" : ""}        models:
          - id: qwen38-local
            name: qwen38-local
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: local
    model: qwen38-local`;
	const inserts = [`    - id: endo-study-observer\n      name: ${join(HERE, "instruments", "observer.mjs")}`];
	if (options.stub)
		inserts.push(`    - id: endo-study-stub-provider\n      name: ${join(HERE, "instruments", "stub-provider.mjs")}`);
	return `${model}
- id: session-persistence-jsonl
  name: "@deepseek-ai/dsh-session-persistence-jsonl"
  config:
    root: ${join(options.home, "sessions")}
    compression: zstd
${rows}
- insert:
${inserts.join("\n")}
`;
}

function runDsh(options: ReproduceOptions, args: string[], env: Record<string, string>, cwd: string): ChildProcess {
	const tsx = join(options.dsh, "node_modules", "tsx", "dist", "esm", "index.mjs");
	const bin = join(options.dsh, "apps", "cli", "src", "bin.ts");
	return spawn(process.execPath, ["--import", tsx, bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}

const wait = (child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});

function sessionFile(home: string): string | null {
	const walk = (dir: string): string[] =>
		existsSync(dir)
			? readdirSync(dir).flatMap((name) =>
					statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)],
				)
			: [];
	return walk(join(home, "sessions")).find((path) => path.endsWith(".jsonl.zstd") || path.endsWith(".jsonl")) ?? null;
}

/** Run one scenario into `<out>/raw/<scenario>/`. Returns the process outcome. */
export async function reproduce(options: ReproduceOptions): Promise<{ code: number | null; dir: string }> {
	// The scenario names a directory that is deleted below: it must be one of ours, never a path.
	if (!(SCENARIOS as readonly string[]).includes(options.scenario))
		throw new Error(`unknown scenario ${JSON.stringify(options.scenario)}`);
	const stub = options.scenario === "stub-retry";
	const base = join(options.out, options.scenario);
	const home = join(base, "home");
	const workspace = join(base, "ws");
	const dir = join(options.out, "raw", options.scenario === "crash" ? "crash-killed" : options.scenario);
	rmSync(base, { recursive: true, force: true });
	mkdirSync(join(home, "profiles"), { recursive: true });
	mkdirSync(workspace, { recursive: true });
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(base, "home-dir"), { recursive: true });
	writeFileSync(join(workspace, "notes.txt"), "alpha\nbeta\ngamma\n");
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: join(base, "home-dir"),
		DSH_HOME: home,
		DSH_PERMISSION_MODE: "read-only",
		DSH_TELEMETRY_DISABLED: "1",
		DSH_OBS_OUT: join(dir, "observer.ndjson"),
		// tsx resolves the checkout's path mapping from this file even though the child runs in the scratch workspace.
		TSX_TSCONFIG_PATH: join(options.dsh, "tsconfig.json"),
		...(options.scenario === "no-key-error" ? {} : { STUDY_PLACEHOLDER_KEY: "not-a-secret" }),
	};
	// First boot creates profiles/headless; the patch then replaces its (empty) user layer.
	await wait(runDsh(options, ["--profile", "headless", "--dump-config"], env, workspace));
	writeFileSync(
		join(home, "profiles", "headless", "cordis.patch.yml"),
		profilePatch({
			home,
			stub,
			modelUrl: options.modelUrl ?? "http://127.0.0.1:8080",
			keyed: options.scenario !== "no-key-error",
		}),
	);
	const child = runDsh(options, ["--profile", "headless", "--json", PROMPTS[options.scenario]], env, workspace);
	let killed = false;
	if (options.scenario === "crash") {
		// SIGKILL the study's own child once the model has streamed a while: no cleanup, no flush.
		const watch = setInterval(() => {
			try {
				const text = readFileSyncSafe(join(dir, "observer.ndjson"));
				if ((text.match(/"kind":"chunk"/g) ?? []).length > 40) {
					killed = true;
					child.kill("SIGKILL");
					clearInterval(watch);
				}
			} catch {}
		}, 100);
		child.on("close", () => clearInterval(watch));
	}
	const result = await wait(child);
	writeFileSync(join(dir, "stream.ndjson"), result.stdout);
	writeFileSync(join(dir, "stderr.txt"), result.stderr);
	const log = sessionFile(home);
	if (log !== null) cpSync(log, join(dir, "session.v4.jsonl.zstd"));
	if (options.scenario === "crash") {
		if (!killed) throw new Error("the model finished before the kill point; use a longer generation");
		// Resume the killed session in a second process: the upstream recovery path, observed from outside.
		const sessionId = (JSON.parse(result.stdout.split("\n")[0] ?? "{}") as { sessionId?: string }).sessionId;
		if (sessionId === undefined) throw new Error("the killed run reported no session id");
		const resumedDir = join(options.out, "raw", "crash-resumed");
		mkdirSync(resumedDir, { recursive: true });
		const after = await wait(
			runDsh(
				options,
				["--profile", "headless", "--json", "--session-id", sessionId, "Reply with the single word: ok"],
				{ ...env, DSH_OBS_OUT: join(resumedDir, "observer.ndjson") },
				workspace,
			),
		);
		writeFileSync(join(resumedDir, "stream.ndjson"), after.stdout);
		writeFileSync(join(resumedDir, "stderr.txt"), after.stderr);
		const resumedLog = sessionFile(home);
		if (resumedLog !== null) cpSync(resumedLog, join(resumedDir, "session.v4.jsonl.zstd"));
	}
	return { code: result.code, dir };
}

function readFileSyncSafe(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const arg = (name: string): string | undefined => {
		const at = process.argv.indexOf(`--${name}`);
		return at >= 0 ? process.argv[at + 1] : undefined;
	};
	const dsh = arg("dsh");
	const out = arg("out");
	if (dsh === undefined || out === undefined)
		throw new Error("usage: reproduce.ts --dsh <checkout> --out <dir> [--scenario ...]");
	const requested = arg("scenario") ?? "stub-retry";
	if (!(SCENARIOS as readonly string[]).includes(requested))
		throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}`);
	const scenario = requested as Scenario;
	const modelUrl = arg("model-url");
	const result = await reproduce({ dsh, out, scenario, ...(modelUrl === undefined ? {} : { modelUrl }) });
	process.stdout.write(`${scenario}: exit ${result.code}, captures in ${result.dir}\n`);
}
