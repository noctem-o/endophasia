// WORK-CYCLE-001A: one DEVELOP work cycle, driven only through Endophasia's public CLI and kept as evidence a later reader can check
// without trusting the agent (research/work-cycle/README.md).
//
//   Launch   a fresh run directory: a store, a copy of the fixture project as a new Git repository, a digest key and (for real Pi) a
//            scratch Pi agent directory. Nothing outside the run directory is written; the user's store, key and Pi configuration
//            are never opened for writing.
//   Doctor   what this run would depend on, observed rather than assumed: Node, script(1), `endo doctor`, the Pi executable and its
//            version, the model endpoint's /v1/models, the Ponytail package and the declared PONYTAIL_DEFAULT_MODE.
//   Drive    endo project add / task add / attempt prepare / attempt check (the baseline: it fails), then the live workbench. The
//            operator types `attempt <id>` and the APPROVE ATTEMPT phrase on the workbench's own terminal; this driver never does.
//   Evidence the candidate change is shown (git diff) and committed only on the operator's answer, checked with `endo attempt check`,
//            and reconstructed by `reconstruct()` from the stored records alone, after the agent has exited.
//   Cleanup  the processes started for the run are looked for and reported; the run directory is kept as the evidence.
//
// Library use (tests/work-cycle-001a.test.ts) and a command line for the operator-governed run:
//
//   node research/work-cycle/driver.ts doctor  [--pi path] [--endpoint url] [--model id] [--expect-pi-version x.y.z]
//   node research/work-cycle/driver.ts run     --pi path --endpoint url --model id [--runs dir]   (interactive; needs a terminal)
//   node research/work-cycle/driver.ts reconstruct --run dir      (reads the run; adds a new evidence/reconstruction-<time> file)
import { spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENDO_CLI = resolve(HERE, "../../cli/index.ts");
export const FIXTURE = join(HERE, "fixture");
export const DRIVER_VERSION = "work-cycle-001a.1";

/** The task the cycle carries. Its acceptance criterion is a command anyone can rerun at the recorded commit. */
export const TASK = {
	title: "Make slugify collapse separators",
	description:
		"src/slug.mjs turns a title into a URL slug. Runs of spaces and punctuation should become one hyphen, and the slug should not start or end with a hyphen.",
	acceptance: "`node --test` exits 0 at a clean commit, and nothing under test/ changed.",
	objective:
		"Fix slugify in src/slug.mjs so that `node --test` passes: every run of characters other than a-z and 0-9 becomes one hyphen, and leading and trailing hyphens are removed.",
	constraints:
		"Edit only src/slug.mjs. Do not change anything under test/. Do not run git and do not commit; leave the change in the working tree. Do not install packages.",
	check: ["node", "--test"],
} as const;

export interface RunLayout {
	readonly run: string;
	/** The Endophasia store root (develop metadata, events, Pi sessions). */
	readonly store: string;
	/** The fixture copy: a Git repository registered as the project. */
	readonly project: string;
	/** The comparison-domain key for this run only (ENDO_DIGEST_KEY_FILE), never the installation key. */
	readonly digestKeyFile: string;
	/** A scratch HOME and Pi agent directory for real Pi (PI_CODING_AGENT_DIR). */
	readonly home: string;
	readonly agentDir: string;
	/** Where the recording proxy keeps model requests (real model runs). */
	readonly capture: string;
	/** Reports written by this driver. */
	readonly evidence: string;
}

const git = (cwd: string, ...args: string[]) => {
	const r = spawnSync(
		"git",
		[
			"-c",
			"user.name=work-cycle operator",
			"-c",
			"user.email=operator@work-cycle.invalid",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
};
export { git as runGit };

/** Launch: a new, self-contained run directory. Refuses to reuse one, so two runs never share a store. */
export function launchRun(run: string): RunLayout {
	if (existsSync(run) && readdirSync(run).length > 0)
		throw new Error(`refusing to reuse a non-empty run directory: ${run}`);
	mkdirSync(run, { recursive: true });
	const root = realpathSync(run);
	const layout: RunLayout = {
		run: root,
		store: join(root, "store"),
		project: join(root, "project"),
		digestKeyFile: join(root, "digest-key", "key"),
		home: join(root, "home"),
		agentDir: join(root, "pi-agent"),
		capture: join(root, "capture"),
		evidence: join(root, "evidence"),
	};
	for (const dir of [layout.store, layout.home, layout.agentDir, layout.evidence, dirname(layout.digestKeyFile)])
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	cpSync(FIXTURE, layout.project, { recursive: true });
	git(layout.project, "init", "-q", "-b", "main");
	git(layout.project, "add", "-A");
	git(layout.project, "commit", "-q", "-m", "fixture: slugify does not collapse separators");
	return layout;
}

/** The environment every `endo` call in a run gets: this process's, with the run's own key. */
export function runEnv(layout: RunLayout, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { ...process.env, ENDO_DIGEST_KEY_FILE: layout.digestKeyFile, ...extra };
}

export interface CliResult {
	readonly args: readonly string[];
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** One public `endo` command, in a new process. Every call is kept in the run's command log. */
export function endo(layout: RunLayout, env: NodeJS.ProcessEnv, ...args: string[]): CliResult {
	const r = spawnSync(process.execPath, [ENDO_CLI, ...args], { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
	const result = { args, status: r.status, stdout: r.stdout, stderr: r.stderr };
	const log = join(layout.evidence, "commands.jsonl");
	writeFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), args, status: r.status })}\n`, { flag: "a" });
	return result;
}

export function json(result: CliResult): any {
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(
			`endo ${result.args.join(" ")} (exit ${result.status}) did not print JSON:\n${result.stdout}\n${result.stderr}`,
		);
	}
}

export interface Prepared {
	readonly projectId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly baseCommit: string;
	/** The check run at the fixture's commit before any agent work: expected to FAIL, and recorded as such. */
	readonly baseline: {
		readonly exit: number | null;
		readonly receiptId: string | null;
		readonly outcome: string | null;
	};
}

/** Drive, part 1: register, write the task, prepare the attempt, and record the baseline check. Sends nothing to any agent. */
export function prepareJourney(layout: RunLayout, env: NodeJS.ProcessEnv): Prepared {
	const S = ["--root", layout.store];
	const projectId = json(
		endo(layout, env, "project", "add", ...S, "--name", "WORK-CYCLE-001A fixture", "--path", layout.project),
	).project.id as string;
	const taskId = json(
		endo(
			layout,
			env,
			"task",
			"add",
			...S,
			"--project",
			projectId,
			"--title",
			TASK.title,
			"--description",
			TASK.description,
			"--acceptance",
			TASK.acceptance,
		),
	).task.id as string;
	const attemptId = json(
		endo(
			layout,
			env,
			"attempt",
			"prepare",
			...S,
			"--project",
			projectId,
			"--task",
			taskId,
			"--objective",
			TASK.objective,
			"--constraints",
			TASK.constraints,
		),
	).attempt.id as string;
	const check = endo(layout, env, "attempt", "check", ...S, "--attempt", attemptId, "--", ...TASK.check);
	let receipt: any = null;
	try {
		receipt = json(check).receipt;
	} catch {
		receipt = null;
	}
	const baseCommit = git(layout.project, "rev-parse", "HEAD").trim();
	return {
		projectId,
		taskId,
		attemptId,
		baseCommit,
		baseline: { exit: check.status, receiptId: receipt?.id ?? null, outcome: receipt?.outcome ?? null },
	};
}

/** The attach command line for this run's workbench (argv, no shell). */
export function attachArgs(
	layout: RunLayout,
	prepared: Prepared,
	subject: { pi: string; provider?: string; model?: string },
): string[] {
	return [
		ENDO_CLI,
		"harness",
		"attach",
		layout.store,
		"--pi",
		subject.pi,
		"--cwd",
		layout.project,
		...(subject.provider === undefined ? [] : ["--provider", subject.provider, "--model", subject.model ?? ""]),
		"--control",
		"--workbench",
		"--project",
		prepared.projectId,
	];
}

/** A scratch Pi agent directory: one OpenAI-compatible provider, and optionally the installed Ponytail package by its absolute path. */
export function writePiAgentDir(
	layout: RunLayout,
	options: { baseUrl: string; provider: string; model: string; ponytailPackage?: string | null; maxTokens?: number },
): void {
	writeFileSync(
		join(layout.agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					[options.provider]: {
						baseUrl: options.baseUrl,
						api: "openai-completions",
						apiKey: "local",
						models: [
							{
								id: options.model,
								contextWindow: 65536,
								maxTokens: options.maxTokens ?? 16384,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	const settings: Record<string, unknown> = { defaultProvider: options.provider, defaultModel: options.model };
	if (options.ponytailPackage) settings.packages = [options.ponytailPackage];
	writeFileSync(join(layout.agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

/** The environment real Pi gets in a run: a scratch HOME and agent directory, offline startup, and the declared Ponytail mode. */
export function piEnv(layout: RunLayout, ponytailMode: string | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		HOME: layout.home,
		XDG_CONFIG_HOME: join(layout.home, ".config"),
		XDG_DATA_HOME: join(layout.home, ".local", "share"),
		PI_CODING_AGENT_DIR: layout.agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		ENDO_DIGEST_KEY_FILE: layout.digestKeyFile,
	};
	if (process.env.TERM !== undefined) env.TERM = process.env.TERM;
	if (ponytailMode !== null) env.PONYTAIL_DEFAULT_MODE = ponytailMode;
	return env;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Doctor

export interface DoctorFinding {
	readonly check: string;
	readonly status: "ok" | "fail" | "unknown" | "skipped";
	readonly observed: string;
}

/** The installed Ponytail package, if any, as Pi would load it from the user's agent directory. Read only. */
export function findPonytail(agentDir = join(homedir(), ".pi", "agent")): { dir: string; version: string } | null {
	const dir = join(agentDir, "npm", "node_modules", "@dietrichgebert", "ponytail");
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
		return { dir: realpathSync(dir), version: typeof pkg.version === "string" ? pkg.version : "unknown" };
	} catch {
		return null;
	}
}

export async function doctor(options: {
	pi?: string;
	endpoint?: string;
	model?: string;
	expectPiVersion?: string;
}): Promise<DoctorFinding[]> {
	const out: DoctorFinding[] = [];
	out.push({ check: "node", status: "ok", observed: process.version });
	const script = spawnSync("script", ["--version"], { encoding: "utf8" });
	out.push({
		check: "script(1) for a pseudo-terminal (automated tiers only)",
		status: script.status === 0 ? "ok" : "unknown",
		observed: script.status === 0 ? script.stdout.trim() : "not found",
	});
	if (options.pi === undefined) out.push({ check: "pi", status: "skipped", observed: "no --pi given" });
	else {
		const v = spawnSync(options.pi, ["--version"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
		});
		const version = (v.stdout ?? "").trim();
		const real = (() => {
			try {
				return realpathSync(options.pi as string);
			} catch {
				return "unresolvable";
			}
		})();
		const expected = options.expectPiVersion;
		out.push({
			check: "pi --version",
			status: v.status !== 0 ? "fail" : expected === undefined || expected === version ? "ok" : "fail",
			observed: `${version || "(none)"} at ${real}${expected !== undefined && expected !== version ? ` (expected ${expected})` : ""}`,
		});
	}
	if (options.endpoint === undefined)
		out.push({ check: "model endpoint", status: "skipped", observed: "no --endpoint given" });
	else {
		try {
			const r = await fetch(`${options.endpoint.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(5000) });
			const body = (await r.json()) as { data?: { id?: string; status?: { value?: string } }[] };
			const ids = (body.data ?? []).map((m) => m.id);
			const entry = (body.data ?? []).find((m) => m.id === options.model);
			out.push({
				check: "model endpoint /models",
				status: entry === undefined ? "fail" : "ok",
				observed: `${ids.length} model(s); ${options.model ?? "(no model named)"} ${entry === undefined ? "NOT listed" : "listed"}`,
			});
			// A llama.cpp router reports whether the model is loaded; another server does not, and that is unknown, not ok.
			const state = entry?.status?.value;
			out.push({
				check: "model loaded",
				status: state === undefined ? "unknown" : state === "loaded" ? "ok" : "fail",
				observed: state ?? "the endpoint does not report a load state",
			});
		} catch (error) {
			out.push({ check: "model endpoint /models", status: "fail", observed: String(error) });
		}
	}
	const ponytail = findPonytail();
	out.push({
		check: "Ponytail package",
		status: ponytail === null ? "unknown" : "ok",
		observed: ponytail === null ? "not found under ~/.pi/agent/npm" : `${ponytail.version} at ${ponytail.dir}`,
	});
	out.push({
		check: "PONYTAIL_DEFAULT_MODE (declared, this process)",
		status: process.env.PONYTAIL_DEFAULT_MODE === undefined ? "unknown" : "ok",
		observed: process.env.PONYTAIL_DEFAULT_MODE ?? "unset",
	});
	return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Ponytail: the effective mode is read from what the child actually sent the model, never from the environment alone.

export type PonytailEffective = "off" | "lite" | "full" | "ultra" | "review" | "mixed" | "not-loaded" | "unknown";

export interface PonytailObservation {
	readonly declared: string | null;
	readonly requests: number;
	/** Per request: the Ponytail instruction block found in its system text, "none", or "not-loaded" (no Ponytail skill listed). */
	readonly perRequest: readonly string[];
	readonly effective: PonytailEffective;
	readonly matchesDeclared: boolean | null;
	readonly basis: string;
}

/** The installed Ponytail's own instruction text per mode, from its own module (so a different release is compared with itself). */
export type PonytailInstructionSet = Record<"lite" | "full" | "ultra" | "review", string>;

export async function ponytailInstructions(dir: string): Promise<PonytailInstructionSet> {
	const { createRequire } = await import("node:module");
	const req = createRequire(join(dir, "package.json"));
	const mod = req("./hooks/ponytail-instructions.js") as { getPonytailInstructions(mode: string): string };
	return {
		lite: mod.getPonytailInstructions("lite"),
		full: mod.getPonytailInstructions("full"),
		ultra: mod.getPonytailInstructions("ultra"),
		review: mod.getPonytailInstructions("review"),
	};
}

function systemText(body: unknown): string | null {
	const messages = (body as { messages?: unknown })?.messages;
	if (!Array.isArray(messages)) return null;
	const parts: string[] = [];
	for (const m of messages as { role?: unknown; content?: unknown }[]) {
		if (m?.role !== "system" && m?.role !== "developer") continue;
		if (typeof m.content === "string") parts.push(m.content);
		else if (Array.isArray(m.content))
			for (const p of m.content as { text?: unknown }[]) if (typeof p?.text === "string") parts.push(p.text);
	}
	return parts.length === 0 ? null : parts.join("\n");
}

export function classifyPonytail(
	bodies: readonly unknown[],
	instructions: Partial<PonytailInstructionSet> | null,
	declared: string | null,
): PonytailObservation {
	const perRequest = bodies.map((body) => {
		const text = systemText(body);
		if (text === null || instructions === null) return "unknown";
		for (const mode of ["ultra", "full", "lite", "review"] as const) {
			const block = instructions[mode]?.trim();
			if (block && text.includes(block)) return mode;
		}
		// Ponytail's skills are listed by name whatever its mode; with no mention at all the package was not loaded in this child. A mention
		// elsewhere (a context file naming Ponytail) would also read as loaded: the positive control is what shows the detector can see.
		return /ponytail/i.test(text) ? "none" : "not-loaded";
	});
	const distinct = [...new Set(perRequest)];
	let effective: PonytailEffective;
	let basis: string;
	if (bodies.length === 0) {
		effective = "unknown";
		basis = "no model request was observed";
	} else if (instructions === null) {
		effective = "unknown";
		basis = "the installed Ponytail's instruction text could not be read, so its presence cannot be tested";
	} else if (distinct.length > 1) {
		effective = "mixed";
		basis = `requests differ: ${distinct.join(", ")}`;
	} else {
		const only = distinct[0] as string;
		effective = only === "none" ? "off" : (only as PonytailEffective);
		basis =
			only === "none"
				? "Ponytail is mentioned (its skills are listed) and none of its lite/full/ultra/review instruction blocks is in any request's system text"
				: only === "not-loaded"
					? "no request's system text mentions Ponytail: the package was not loaded"
					: only === "unknown"
						? "a request had no system text"
						: `the ${only} instruction block is in every request's system text`;
	}
	const normalized = declared?.trim().toLowerCase() ?? null;
	const matchesDeclared =
		normalized === null || effective === "unknown" || effective === "mixed" ? null : effective === normalized;
	return { declared, requests: bodies.length, perRequest, effective, matchesDeclared, basis };
}

/** Request bodies the recording proxy captured under `captureStore`, decoded. Requires the run's digest key. */
export async function capturedChatBodies(captureStore: string, digestKeyFile: string): Promise<unknown[]> {
	const { readEndoCaptureEventsV0, endoCaptureRootV0 } = await import("../../adapters/openai-proxy/capture-log.ts");
	const { createEndoBlobStoreV0 } = await import("../../storage/blob-store.ts");
	const { endoDigestKeyFromEnvironmentV0 } = await import("../../storage/digest-key.ts");
	// The run's own key, passed explicitly: the reader neither changes this process's environment nor creates a key that is not there.
	if (!existsSync(digestKeyFile)) throw new Error(`no digest key at ${digestKeyFile}: the capture cannot be read`);
	const key = endoDigestKeyFromEnvironmentV0({ ENDO_DIGEST_KEY_FILE: digestKeyFile });
	const blobs = createEndoBlobStoreV0(endoCaptureRootV0(captureStore), key, { readOnly: true });
	const out: unknown[] = [];
	for (const event of readEndoCaptureEventsV0(captureStore)) {
		if (event.kind !== "capture.request") continue;
		const p = event.payload as { path?: string; body?: { digest?: any } };
		if (typeof p.path !== "string" || !p.path.endsWith("/chat/completions") || p.body?.digest === undefined) continue;
		out.push(JSON.parse(Buffer.from(blobs.get(p.body.digest)).toString("utf8")));
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cleanup: processes started for the run, found by their working directory or command line naming the run directory.

export function processesOfRun(layout: RunLayout): { pid: number; cmd: string }[] {
	const found: { pid: number; cmd: string }[] = [];
	if (process.platform !== "linux") return found;
	// This process and its ancestors (a shell, npx or timeout that names the run) are the reader, not the run.
	const ancestors = new Set<number>([process.pid]);
	for (let pid = process.ppid; pid > 1 && !ancestors.has(pid); ) {
		ancestors.add(pid);
		try {
			pid = Number(/^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
		} catch {
			break;
		}
	}
	const under = (path: string) => path === layout.run || path.startsWith(`${layout.run}/`);
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry) || ancestors.has(Number(entry))) continue;
		try {
			const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8")
				.split("\0")
				.filter((arg) => arg.length > 0);
			let cwd = "";
			try {
				cwd = readlinkSync(`/proc/${entry}/cwd`);
			} catch {}
			// An argument that is a path in the run (or names one after `=`), or a working directory in it; never a prefix of another name.
			if (argv.some((arg) => under(arg) || under(arg.slice(arg.indexOf("=") + 1))) || under(cwd))
				found.push({ pid: Number(entry), cmd: argv.join(" ") });
		} catch {}
	}
	return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Evidence: reconstruct the cycle from what is stored, in new processes, with no agent running. Every fact says where it came from.

export interface RunIds {
	readonly projectId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly baseCommit: string;
}

export interface Reconstruction {
	readonly driver: string;
	readonly readAt: string;
	readonly liveProcesses: readonly { pid: number; cmd: string }[];
	readonly task: {
		readonly source: string;
		readonly title: string;
		readonly acceptance: string;
		readonly status: string;
		readonly revision: number;
		readonly history: readonly { atMs: number; from: string | null; to: string; note: string | null }[];
	};
	readonly attempt: {
		readonly source: string;
		readonly state: string;
		readonly label: string;
		readonly frozenAcceptance: string;
		readonly authorized: null | {
			recordedAtMs: number;
			session: string;
			approvedBy: string;
			via: string;
			briefSha256: string;
		};
		readonly execution: null | Record<string, unknown>;
	};
	readonly run: {
		readonly source: string;
		readonly derivedBy: string;
		readonly dispatchSequence: number | null;
		readonly endKind: string | null;
		readonly tools: Readonly<Record<string, { started: number; finished: number; errors: number }>>;
		readonly assistantStopReasons: readonly string[];
	};
	readonly artifact: {
		readonly source: string;
		readonly head: string;
		readonly clean: boolean;
		readonly commits: readonly { commit: string; committer: string; subject: string }[];
		readonly changedFiles: readonly string[];
		readonly testsChanged: boolean;
		readonly provenance: string;
	};
	readonly receipts: readonly {
		readonly id: string;
		readonly commit: string;
		readonly outcome: string;
		readonly relation: string;
		readonly execution: unknown;
		readonly startedAtMs: number;
	}[];
	readonly receiptLimitations: readonly string[];
	/** Ponytail's own per-session override: `ponytail-mode` entries in Pi's session files (counted by marker; contents not read out). */
	readonly ponytailSessionEntries: number | null;
	readonly verdicts: {
		readonly piRun: string;
		readonly checkAtHead: string;
		readonly operatorDecision: string;
	};
	readonly unknowns: readonly string[];
}

function allEvents(layout: RunLayout, env: NodeJS.ProcessEnv, pageSize = 500): any[] {
	const out: any[] = [];
	let after: number | undefined;
	for (let page = 0; page < 10_000; page++) {
		const args = [
			"events",
			layout.store,
			"--limit",
			String(pageSize),
			...(after === undefined ? [] : ["--after", String(after)]),
		];
		const r = endo(layout, env, ...args);
		if (r.status !== 0) throw new Error(`endo events failed (exit ${r.status}): ${r.stderr}`);
		// The cursor is the store's position (`nextAfterSequence`), never an event's own `sequence`, which counts per stream.
		const body = json(r) as { events?: any[]; nextAfterSequence?: unknown };
		const events = body.events ?? [];
		out.push(...events);
		if (events.length < pageSize) break;
		if (typeof body.nextAfterSequence !== "number") throw new Error("endo events gave no nextAfterSequence");
		after = body.nextAfterSequence;
	}
	return out;
}

/**
 * The tool activity in the attempt's run window, read from the event log: names, counts and error flags only, never arguments.
 * The window is the one `runAfter` uses (runtime/contracts/develop-attempt-execution.ts):
 *   - the dispatch derived from the authorisation, in the authorised session;
 *   - then the first `run-started` of the Pi process attached at that dispatch, with no other dispatch to the session before it;
 *   - then that run's events, up to its end or until the process ends or is replaced.
 */
function runActivity(events: readonly any[], authorized: any): Reconstruction["run"] {
	const source =
		"endo events (canonical event log: tool names, error flags and keyed digests; no arguments or results)";
	const derivedBy =
		"this report, following Endophasia's own run window (the first run of the same Pi process after the dispatch); not part of Endophasia's execution reading";
	const tools: Record<string, { started: number; finished: number; errors: number }> = {};
	const stops: string[] = [];
	const none = { source, derivedBy, dispatchSequence: null, endKind: null, tools, assistantStopReasons: stops };
	if (authorized === null) return none;
	const inSession = (e: any) => e.coordinates?.sessionId === authorized.session;
	const at = events.findIndex(
		(e) =>
			e.kind === "workbench.prompt-dispatched" &&
			inSession(e) &&
			e.payload?.proposalId === authorized.proposalId &&
			Array.isArray(e.derivedFrom) &&
			e.derivedFrom.includes(authorized.authorizationEventId),
	);
	if (at < 0) return none;
	let instance: string | null = null;
	for (let i = at - 1; i >= 0; i--) {
		const e = events[i];
		if (inSession(e) && (e.kind === "lifecycle.session-started" || e.kind === "lifecycle.session-resumed")) {
			instance = typeof e.payload?.instance === "string" ? e.payload.instance : null;
			break;
		}
	}
	let started = false;
	let endKind: string | null = null;
	for (const e of events.slice(at + 1)) {
		if (!inSession(e)) continue;
		if (!started) {
			if (e.kind === "workbench.prompt-dispatched") break; // a later prompt's run is not this attempt's
			if (e.kind === "lifecycle.run-started") {
				if (instance === null || e.payload?.instance !== instance) {
					endKind = "process-ended";
					break;
				}
				started = true;
			} else if (/^lifecycle\.(interrupted|detached|session-started|session-resumed)$/.test(e.kind)) {
				endKind = "process-ended";
				break;
			}
			continue;
		}
		if (e.kind === "tool.started" || e.kind === "tool.finished") {
			const name = String(e.payload?.toolName ?? "?");
			tools[name] ??= { started: 0, finished: 0, errors: 0 };
			const t = tools[name];
			if (e.kind === "tool.started") t.started += 1;
			else {
				t.finished += 1;
				if (e.payload?.isError === true) t.errors += 1;
			}
		}
		if (typeof e.payload?.stopReason === "string" && e.kind.startsWith("message")) stops.push(e.payload.stopReason);
		if (
			/^lifecycle\.(run-(completed|failed|aborted|unclassified)|interrupted|detached|session-started|session-resumed)$/.test(
				e.kind,
			)
		) {
			endKind = e.kind;
			break;
		}
	}
	return {
		source,
		derivedBy,
		dispatchSequence: events[at].sequence ?? null,
		endKind,
		tools,
		assistantStopReasons: stops,
	};
}

/** Endophasia's run state for the window end this report found, to compare with the execution reading. */
const END_AS_RUN: Readonly<Record<string, string>> = {
	"lifecycle.run-completed": "completed",
	"lifecycle.run-failed": "failed",
	"lifecycle.run-aborted": "aborted",
	"lifecycle.run-unclassified": "unclassified",
	"lifecycle.interrupted": "interrupted",
	"lifecycle.detached": "interrupted",
	"lifecycle.session-started": "interrupted",
	"lifecycle.session-resumed": "interrupted",
	"process-ended": "process-ended",
};

function ponytailEntries(store: string): number | null {
	const dir = join(store, "pi-sessions");
	if (!existsSync(dir)) return null;
	let count = 0;
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile())
				for (const line of readFileSync(p, "utf8").split("\n"))
					if (line.includes('"customType":"ponytail-mode"')) count += 1;
		}
	};
	walk(dir);
	return count;
}

export function reconstruct(
	layout: RunLayout,
	ids: RunIds,
	env: NodeJS.ProcessEnv = runEnv(layout),
	options: { readonly pageSize?: number } = {},
): Reconstruction {
	const S = ["--root", layout.store];
	const unknowns: string[] = [];
	const task = json(endo(layout, env, "task", "show", ...S, "--project", ids.projectId, "--task", ids.taskId)).task;
	const shown = json(endo(layout, env, "attempt", "show", ...S, "--attempt", ids.attemptId)).attempt;
	const receiptsRead = json(
		endo(layout, env, "attempt", "receipts", ...S, "--attempt", ids.attemptId, "--cwd", layout.project),
	);
	const receipts = (receiptsRead.receipts as any[]).map((r) => ({
		id: r.id,
		commit: r.commit,
		outcome: r.outcome,
		relation: r.relation,
		execution: r.execution,
		startedAtMs: r.startedAtMs,
	}));
	const newest = receipts[receipts.length - 1];
	const limitations =
		newest === undefined
			? []
			: (json(endo(layout, env, "attempt", "receipt", ...S, "--receipt", newest.id, "--cwd", layout.project)).receipt
					.limitations as string[]);
	if ((receiptsRead.problems as unknown[]).length > 0)
		unknowns.push(`receipt problems reported: ${JSON.stringify(receiptsRead.problems)}`);

	const events = allEvents(layout, env, options.pageSize);
	const run = runActivity(events, shown.authorized);

	const head = git(layout.project, "rev-parse", "HEAD").trim();
	const clean = git(layout.project, "status", "--porcelain=v1", "--untracked-files=all").trim().length === 0;
	const commits = git(layout.project, "log", "--format=%H%x09%cn%x09%s", `${ids.baseCommit}..HEAD`)
		.trim()
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => {
			const [commit, committer, subject] = l.split("\t");
			return { commit: commit as string, committer: committer as string, subject: subject as string };
		});
	const changedFiles = git(layout.project, "diff", "--name-only", "--no-renames", ids.baseCommit, "HEAD")
		.trim()
		.split("\n")
		.filter((l) => l.length > 0);
	if (!clean)
		unknowns.push("the working tree has uncommitted changes now: they are in no commit and no receipt covers them");

	const exec = shown.execution as Record<string, unknown> | null;
	if (exec === null) unknowns.push("no authorisation record: nothing shows this attempt was sent to an agent");
	else if (exec.evidence !== "complete") unknowns.push(`the event log was read as ${String(exec.evidence)}`);
	if (run.dispatchSequence !== null && run.endKind === null) unknowns.push("no run end was found after the dispatch");
	if (exec !== null && run.endKind !== null && END_AS_RUN[run.endKind] !== exec.run)
		unknowns.push(
			`this report's run window ended ${run.endKind}, but Endophasia's reading says run ${String(exec.run)}: the tool counts may not be this run's`,
		);
	const atHead = [...receipts].reverse().find((r) => r.relation === "at-head");
	if (atHead === undefined)
		unknowns.push("no receipt was recorded at the current HEAD: the current revision is unchecked");
	const decision = (task.history as any[]).at(-1);
	unknowns.push(
		"which bytes of the candidate commit Pi wrote: Endophasia records tool names and digests, not file contents, and the commit was made by the operator",
		"the model's identity as served: the provider and model name are configuration; the server's weights were not hashed by this run",
	);
	return {
		driver: DRIVER_VERSION,
		readAt: new Date().toISOString(),
		liveProcesses: processesOfRun(layout),
		task: {
			source: "endo task show (develop/tasks.json, the operator's metadata)",
			title: task.title,
			acceptance: task.acceptance,
			status: task.status,
			revision: task.revision,
			history: task.history,
		},
		attempt: {
			source:
				"endo attempt show (write-once attempt and authorisation records, joined to the event log by exact ids)",
			state: shown.state,
			label: shown.label,
			frozenAcceptance: shown.attempt.task.acceptance,
			authorized:
				shown.authorized === null
					? null
					: {
							recordedAtMs: shown.authorized.recordedAtMs,
							session: shown.authorized.session,
							approvedBy: shown.authorized.approvedBy,
							via: shown.authorized.via,
							briefSha256: shown.authorized.briefSha256,
						},
			execution: exec,
		},
		run,
		artifact: {
			source: "git, read now in the project's working tree",
			head,
			clean,
			commits,
			changedFiles,
			testsChanged: changedFiles.some((f) => f.startsWith("test/")),
			provenance:
				"declared, not observed: the receipts (and, in a driver run, the commit message) name the attempt because the operator chose to: the driver runs `endo attempt check --attempt` and commits only on the operator's yes. Nothing Endophasia observed links the attempt's run to these bytes",
		},
		receipts,
		receiptLimitations: limitations,
		ponytailSessionEntries: ponytailEntries(layout.store),
		verdicts: {
			piRun:
				exec === null
					? "not sent"
					: `send ${String(exec.send)}, run ${String(exec.run)} (as Pi reported it; not verification, not acceptance)`,
			checkAtHead:
				atHead === undefined
					? "no check at the current HEAD"
					: `${atHead.outcome} at ${atHead.commit.slice(0, 12)} (observed by endo attempt check; not acceptance)`,
			operatorDecision:
				decision === undefined
					? "unknown"
					: `status ${task.status}${decision.from === null ? " (as created)" : `, moved ${decision.from} → ${decision.to} by \`endo task status\` or the paired page (the history records no actor)`}${decision.note ? `: "${decision.note}"` : ""}`,
		},
		unknowns,
	};
}

export function renderReconstruction(r: Reconstruction): string {
	const tools = Object.entries(r.run.tools)
		.map(([name, t]) => `${name} ×${t.started}${t.errors > 0 ? ` (${t.errors} returned an error)` : ""}`)
		.join(", ");
	const lines = [
		`# WORK-CYCLE-001A reconstruction`,
		"",
		`Read ${r.readAt} by ${r.driver}, from stored records only. Processes of the run still alive: ${r.liveProcesses.length}.`,
		"",
		`## Task (${r.task.source})`,
		`- ${r.task.title}; status **${r.task.status}** (revision ${r.task.revision})`,
		`- Acceptance: ${r.task.acceptance}`,
		...r.task.history.map(
			(h) =>
				`- ${new Date(h.atMs).toISOString()}: ${h.from ?? "(created)"} → ${h.to}${h.note ? ` — "${h.note}"` : ""}`,
		),
		"",
		`## Attempt (${r.attempt.source})`,
		`- ${r.attempt.label} (state ${r.attempt.state}); acceptance as frozen in the brief: ${r.attempt.frozenAcceptance}`,
		r.attempt.authorized === null
			? "- Not authorised"
			: `- Authorised ${new Date(r.attempt.authorized.recordedAtMs).toISOString()} by ${r.attempt.authorized.approvedBy} via ${r.attempt.authorized.via}, session ${r.attempt.authorized.session}, brief sha256 ${r.attempt.authorized.briefSha256.slice(0, 16)}…`,
		`- Execution reading: ${JSON.stringify(r.attempt.execution)}`,
		"",
		`## Run activity (${r.run.source})`,
		`- Derived by ${r.run.derivedBy}`,
		`- Dispatch at sequence ${r.run.dispatchSequence ?? "—"}; run end ${r.run.endKind ?? "not found"}; tools: ${tools || "none"}`,
		"",
		`## Artifact (${r.artifact.source})`,
		`- HEAD ${r.artifact.head} (${r.artifact.clean ? "clean" : "DIRTY"}); files changed since the fixture commit: ${r.artifact.changedFiles.join(", ") || "none"}; test/ changed: ${r.artifact.testsChanged}`,
		...r.artifact.commits.map((c) => `- ${c.commit.slice(0, 12)} by ${c.committer}: ${c.subject}`),
		`- Provenance: ${r.artifact.provenance}`,
		"",
		"## Verification receipts (endo attempt receipts, compared with HEAD now)",
		...r.receipts.map(
			(x) =>
				`- ${x.id}: **${x.outcome}** at ${x.commit.slice(0, 12)}, ${x.relation}, ${JSON.stringify(x.execution)}`,
		),
		...r.receiptLimitations.map((l) => `  - does not show: ${l}`),
		"",
		`Ponytail \`ponytail-mode\` entries in Pi's session files: ${r.ponytailSessionEntries ?? "no session directory"}`,
		"",
		"## Three separate answers",
		`- Pi: ${r.verdicts.piRun}`,
		`- Check: ${r.verdicts.checkAtHead}`,
		`- Operator: ${r.verdicts.operatorDecision}`,
		"",
		"## Unknown or not established",
		...r.unknowns.map((u) => `- ${u}`),
		"",
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The operator-governed run (interactive). The approval is typed by the operator on the workbench's own terminal: this process
// starts `endo harness attach` with the terminal inherited and never writes to it.

function flag(argv: readonly string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
}

async function ask(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return (await rl.question(question)).trim();
	} finally {
		rl.close();
	}
}

/** The child's exit code; a child that could not be started (a bad path) resolves as null rather than hanging. */
function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((done) => {
		if (child.exitCode !== null) return done(child.exitCode);
		child.once("exit", (code) => done(code));
		child.once("error", () => done(null));
	});
}

async function startProxy(layout: RunLayout, upstream: string): Promise<{ origin: string; stop(): Promise<void> }> {
	const child = spawn(
		process.execPath,
		[ENDO_CLI, "proxy", "record", "--upstream", upstream, "--store", layout.capture],
		{
			env: runEnv(layout),
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		},
	);
	let err = "";
	child.stderr.on("data", (c) => {
		err += String(c);
	});
	const exit = waitForExit(child);
	for (let i = 0; i < 200 && !/recording (http:\/\/\S+) ->/.test(err); i++)
		await new Promise((r) => setTimeout(r, 50));
	const origin = /recording (http:\/\/\S+) ->/.exec(err)?.[1];
	if (origin === undefined) throw new Error(`the recording proxy did not start:\n${err}`);
	return {
		origin,
		async stop() {
			if (child.exitCode === null) child.kill("SIGTERM");
			await exit;
		},
	};
}

async function operatorRun(argv: readonly string[]): Promise<void> {
	const pi = flag(argv, "--pi");
	const endpoint = flag(argv, "--endpoint");
	const model = flag(argv, "--model");
	const expectPiVersion = flag(argv, "--expect-pi-version");
	if (pi === undefined || endpoint === undefined || model === undefined)
		throw new TypeError(
			"usage: driver.ts run --pi <path> --endpoint <http://host:port/v1> --model <id> [--expect-pi-version x.y.z] [--runs dir]",
		);
	if (!process.stdin.isTTY)
		throw new Error("the operator-governed run needs a terminal: the workbench approves only there");
	const endpointUrl = new URL(endpoint);
	if (endpointUrl.pathname.replace(/\/$/, "") !== "/v1")
		throw new TypeError("--endpoint must be an OpenAI-compatible base ending in /v1 (the proxy relays the origin)");
	const runs = flag(argv, "--runs") ?? join(homedir(), "projects", "endophasia-research", "work-cycle-001a");
	const layout = launchRun(join(runs, new Date().toISOString().replace(/[:.]/g, "-")));
	const say = (line: string) => process.stderr.write(`[work-cycle] ${line}\n`);
	say(`run directory ${layout.run} (kept as the evidence)`);

	// Doctor
	const declared = process.env.PONYTAIL_DEFAULT_MODE ?? null;
	const findings = await doctor({
		pi,
		endpoint,
		model,
		...(expectPiVersion === undefined ? {} : { expectPiVersion }),
	});
	writeFileSync(join(layout.evidence, "doctor.json"), `${JSON.stringify(findings, null, 2)}\n`);
	for (const f of findings) say(`doctor ${f.status.padEnd(7)} ${f.check}: ${f.observed}`);
	if (findings.some((f) => f.status === "fail"))
		throw new Error("doctor failed; nothing was started (see doctor.json)");

	// Drive, part 1
	const prepared = prepareJourney(layout, runEnv(layout));
	writeFileSync(
		join(layout.run, "run.json"),
		`${JSON.stringify({ ...prepared, driver: DRIVER_VERSION, model, endpoint, pi, declaredPonytail: declared }, null, 2)}\n`,
	);
	say(
		`baseline check at the fixture commit: ${prepared.baseline.outcome} (exit ${prepared.baseline.exit}); expected: failed`,
	);

	const proxy = await startProxy(layout, endpointUrl.origin);
	const ponytail = findPonytail();
	let code: number | null = null;
	const ignore = () => {};
	try {
		writePiAgentDir(layout, {
			baseUrl: `${proxy.origin}/v1`,
			provider: "work-cycle",
			model,
			ponytailPackage: ponytail?.dir ?? null,
		});
		say("starting the workbench. On ITS terminal (this one), type:");
		say(`    attempt ${prepared.attemptId}`);
		say(
			"then read the brief and type the APPROVE ATTEMPT phrase it shows if you approve. When the run has ended, press Ctrl-C.",
		);
		// Ctrl-C belongs to the workbench; this driver continues after it ends (and stops the proxy whatever happens).
		process.on("SIGINT", ignore);
		const attach = spawn(process.execPath, attachArgs(layout, prepared, { pi, provider: "work-cycle", model }), {
			env: piEnv(layout, declared),
			stdio: "inherit",
		});
		code = await waitForExit(attach);
	} finally {
		process.off("SIGINT", ignore);
		await proxy.stop();
	}
	say(`the workbench ended (exit ${code})`);

	// Evidence: the candidate (tracked changes, new files and any commit made since the fixture), the operator's decision to commit it,
	// the check, the reconstruction.
	const head = git(layout.project, "rev-parse", "HEAD").trim();
	if (head !== prepared.baseCommit)
		say(
			`WARNING: HEAD moved during the run (${prepared.baseCommit.slice(0, 12)} → ${head.slice(0, 12)}): something committed; the brief said not to`,
		);
	const status = git(layout.project, "status", "--porcelain=v1", "--untracked-files=all");
	// Intent-to-add makes new files part of the diff the operator reads, so nothing is committed that was not shown.
	if (status.trim().length > 0) git(layout.project, "add", "-A", "-N");
	const candidate = git(layout.project, "diff", "--no-renames", prepared.baseCommit);
	process.stderr.write(
		`\n${status}\n${git(layout.project, "diff", "--no-renames", "--stat", prepared.baseCommit)}\n${candidate}\n`,
	);
	writeFileSync(join(layout.evidence, "candidate.diff"), candidate);
	writeFileSync(join(layout.evidence, "candidate-status.txt"), status);
	if (status.trim().length === 0) say("the working tree has no uncommitted change: there is nothing to commit");
	else if ((await ask("[work-cycle] commit exactly what is shown above, as the operator? (yes/no) ")) === "yes") {
		git(layout.project, "add", "-A");
		git(
			layout.project,
			"commit",
			"-q",
			"-m",
			`candidate for ${prepared.attemptId} (committed on the operator's yes)`,
		);
		const check = endo(
			layout,
			runEnv(layout),
			"attempt",
			"check",
			"--root",
			layout.store,
			"--attempt",
			prepared.attemptId,
			"--",
			...TASK.check,
		);
		say(`check at the candidate commit: exit ${check.status}`);
	} else say("not committed; no check was run");

	const ponytailObserved = classifyPonytail(
		await capturedChatBodies(layout.capture, layout.digestKeyFile),
		ponytail === null ? null : await ponytailInstructions(ponytail.dir),
		declared,
	);
	writeFileSync(
		join(layout.evidence, "ponytail.json"),
		`${JSON.stringify({ package: ponytail, ...ponytailObserved, perRequest: undefined, requestModes: ponytailObserved.perRequest }, null, 2)}\n`,
	);
	say(`Ponytail: declared ${declared ?? "unset"}, observed ${ponytailObserved.effective} (${ponytailObserved.basis})`);
	const written = writeReconstruction(layout, prepared);
	const leaked = processesOfRun(layout);
	writeFileSync(join(layout.evidence, "cleanup.json"), `${JSON.stringify({ leaked }, null, 2)}\n`);
	say(`processes of this run still alive: ${leaked.length}`);
	say(`reconstruction: ${written}`);
	say("The decision is yours, separately. For example:");
	say(
		`    ENDO_DIGEST_KEY_FILE=${layout.digestKeyFile} node ${ENDO_CLI} task status --root ${layout.store} --project ${prepared.projectId} --task ${prepared.taskId} --to in-progress`,
	);
	say(
		'    … then --to review, then --to done --note "…" (each its own act), and rerun: driver.ts reconstruct --run <dir>',
	);
}

/** Write a reconstruction beside the earlier ones (never over them), and return the markdown file's path. */
function writeReconstruction(layout: RunLayout, ids: RunIds): string {
	const r = reconstruct(layout, ids);
	const stamp = r.readAt.replace(/[:.]/g, "-");
	writeFileSync(join(layout.evidence, `reconstruction-${stamp}.json`), `${JSON.stringify(r, null, 2)}\n`, {
		flag: "wx",
	});
	const md = join(layout.evidence, `reconstruction-${stamp}.md`);
	writeFileSync(md, renderReconstruction(r), { flag: "wx" });
	return md;
}

async function main(argv: readonly string[]): Promise<void> {
	const [command, ...rest] = argv;
	if (command === "doctor") {
		const expectPiVersion = flag(rest, "--expect-pi-version");
		const findings = await doctor({
			pi: flag(rest, "--pi"),
			endpoint: flag(rest, "--endpoint"),
			model: flag(rest, "--model"),
			...(expectPiVersion === undefined ? {} : { expectPiVersion }),
		});
		process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
		process.exitCode = findings.some((f) => f.status === "fail") ? 1 : 0;
	} else if (command === "run") await operatorRun(rest);
	else if (command === "reconstruct") {
		const run = flag(rest, "--run");
		if (run === undefined) throw new TypeError("usage: driver.ts reconstruct --run <dir>");
		const root = realpathSync(run);
		const ids = JSON.parse(readFileSync(join(root, "run.json"), "utf8")) as RunIds;
		const layout: RunLayout = {
			run: root,
			store: join(root, "store"),
			project: join(root, "project"),
			digestKeyFile: join(root, "digest-key", "key"),
			home: join(root, "home"),
			agentDir: join(root, "pi-agent"),
			capture: join(root, "capture"),
			evidence: join(root, "evidence"),
		};
		process.stdout.write(readFileSync(writeReconstruction(layout, ids), "utf8"));
	} else throw new TypeError("usage: driver.ts <doctor|run|reconstruct> ...");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
