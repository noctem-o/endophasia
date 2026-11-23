// The read-only Endophasia status reader the OpenClaw plugin runs (docs/designs/coordinator-status.md §OpenClaw).
//
// It runs ONE fixed command, `endo coordinator status --quiet --root <storeRoot> --project <id>...`, with an argv built only from the
// operator's plugin config: the model chooses at most which permitted project to ask about, never a path, a flag or a command. No shell,
// a scrubbed environment (the gateway's provider credentials never reach the child), a timeout, an output bound, and always a
// bubblewrap sandbox: no network, an empty root, and read-only binds of exactly what the read needs (the system's /usr, the node
// binary, endo's own code, the store's develop/ and events/ directories, and the requested projects' roots).
// There is no unsandboxed mode: if bubblewrap is missing or cannot start, the read is `unavailable` and endo never runs. What comes back is
// validated against the protocol's own validator before anything is relayed; another schema version is refused, not guessed at.
//
// This module has no OpenClaw or TypeBox import, so it is tested directly (tests/openclaw-endophasia-status.test.ts).

import { execFile } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type EndoCoordinatorStatusV0, validateEndoCoordinatorStatusV0 } from "../../../protocol/coordinator-status.ts";

export interface EndophasiaStatusConfigV0 {
	endo: { node: string; entry: string };
	storeRoot: string;
	projects: { id: string; root: string; label?: string }[];
	staleAfterSeconds?: number;
	timeoutMs?: number;
	bwrapPath?: string;
	disclose?: { taskTitles?: boolean; detail?: boolean };
}

export const ENDOPHASIA_STATUS_LIMITS_V0 = Object.freeze({
	defaultTimeoutMs: 20_000,
	maxTimeoutMs: 60_000,
	maxStdoutBytes: 4 * 1024 * 1024,
	maxProjects: 8,
	defaultStaleAfterSeconds: 600,
});

const PROJECT_ID = /^endo\.project\.[0-9a-f]{32}$/;
/** The store directories the status read opens. Nothing else of the store (control socket, artifacts, harness state) is mounted. */
const STORE_DIRS = ["develop", "events"];
/** System files node and git may consult; bound read-only when present. */
const SYSTEM_FILES = ["/etc/ld.so.cache", "/etc/localtime", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf"];
/** Top-level directories that are often symlinks into /usr (merged /usr); recreated as the same symlink, else bound read-only. */
const SYSTEM_LINKS = ["/bin", "/sbin", "/lib", "/lib64"];

export class EndophasiaStatusConfigErrorV0 extends Error {}

/** Check the operator's config strictly. Anything relative, missing or out of bounds is refused; nothing is defaulted silently. */
export function validateEndophasiaStatusConfigV0(value: unknown): EndophasiaStatusConfigV0 {
	const bad = (what: string): never => {
		throw new EndophasiaStatusConfigErrorV0(`endophasia-status config: ${what}`);
	};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("not an object");
	const c = value as Record<string, unknown>;
	const allowed = new Set([
		"endo",
		"storeRoot",
		"projects",
		"staleAfterSeconds",
		"timeoutMs",
		"bwrapPath",
		"disclose",
	]);
	for (const key of Object.keys(c)) if (!allowed.has(key)) bad(`unknown key ${key}`);
	const endo = c.endo as Record<string, unknown> | undefined;
	if (typeof endo !== "object" || endo === null) return bad("endo is required ({ node, entry })");
	for (const key of ["node", "entry"] as const) {
		const v = endo[key];
		if (typeof v !== "string" || !isAbsolute(v)) bad(`endo.${key} must be an absolute path`);
	}
	if (typeof c.storeRoot !== "string" || !isAbsolute(c.storeRoot)) bad("storeRoot must be an absolute path");
	if (!Array.isArray(c.projects) || c.projects.length === 0) bad("projects must list at least one permitted project");
	const projects = c.projects as unknown[];
	if (projects.length > ENDOPHASIA_STATUS_LIMITS_V0.maxProjects) bad("too many projects");
	for (const p of projects) {
		const entry = p as Record<string, unknown>;
		if (typeof entry !== "object" || entry === null || typeof entry.id !== "string" || !PROJECT_ID.test(entry.id))
			bad("each project needs an id of the form endo.project.<32 hex>");
		if (typeof entry.root !== "string" || !isAbsolute(entry.root) || resolve(entry.root) === "/")
			bad("each project needs root: the absolute path of its registered working tree");
		if (entry.label !== undefined && (typeof entry.label !== "string" || entry.label.length > 80))
			bad("a project label is a short string");
	}
	if (c.staleAfterSeconds !== undefined) {
		const n = c.staleAfterSeconds;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 7 * 24 * 3600)
			bad("staleAfterSeconds must be 1..604800");
	}
	if (c.timeoutMs !== undefined) {
		const n = c.timeoutMs;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1000 || n > ENDOPHASIA_STATUS_LIMITS_V0.maxTimeoutMs)
			bad("timeoutMs must be 1000..60000");
	}
	if (c.bwrapPath !== undefined && (typeof c.bwrapPath !== "string" || !isAbsolute(c.bwrapPath)))
		bad("bwrapPath must be absolute");
	if (c.disclose !== undefined) {
		const d = c.disclose as Record<string, unknown>;
		if (typeof d !== "object" || d === null) bad("disclose must be an object");
		for (const key of Object.keys(d))
			if (key !== "taskTitles" && key !== "detail") bad(`unknown disclose key ${key}`);
		if (d.taskTitles !== undefined && typeof d.taskTitles !== "boolean") bad("disclose.taskTitles must be a boolean");
		if (d.detail !== undefined && typeof d.detail !== "boolean") bad("disclose.detail must be a boolean");
	}
	return value as EndophasiaStatusConfigV0;
}

/** The permitted project ids a request may read: one named project (by id or label), or all of them. Anything else is refused. */
export function selectEndophasiaProjectsV0(
	config: EndophasiaStatusConfigV0,
	project: string | undefined,
): string[] | null {
	if (project === undefined || project.trim() === "") return config.projects.map((p) => p.id);
	const wanted = project.trim();
	const hit = config.projects.find(
		(p) => p.id === wanted || (p.label !== undefined && p.label.toLowerCase() === wanted.toLowerCase()),
	);
	return hit === undefined ? null : [hit.id];
}

export interface EndophasiaCommandV0 {
	file: string;
	args: string[];
	env: Record<string, string>;
}

/** What the command builder may look at on the host: paths only, read-only. Injected in tests. */
export interface EndophasiaHostViewV0 {
	exists(path: string): boolean;
	/** The symlink target of `path`, or null if it is not a symlink. */
	link(path: string): string | null;
	kind(path: string): "directory" | "other" | "missing";
	real(path: string): string;
}

export const realHostViewV0: EndophasiaHostViewV0 = {
	exists: existsSync,
	link: (path) => (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? readlinkSync(path) : null),
	kind: (path) => {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		return stat === undefined ? "missing" : stat.isDirectory() ? "directory" : "other";
	},
	real: (path) => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	},
};

class ProjectGitLayoutError extends Error {}
class ProjectRootError extends Error {}

/** endo's own code: the nearest ancestor of the entry with a package.json and node_modules, else the entry's directory. */
function codeRootOf(entry: string, host: EndophasiaHostViewV0): string {
	for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir))
		if (host.exists(join(dir, "package.json")) && host.exists(join(dir, "node_modules"))) return dir;
	return dirname(entry);
}

/**
 * The exact command, built from config only: bubblewrap over an empty root with read-only binds of exactly what one status read of
 * `projectIds` needs. Nothing under the home directory is mounted unless it is one of those paths.
 */
export function endophasiaStatusCommandV0(
	config: EndophasiaStatusConfigV0,
	projectIds: readonly string[],
	host: EndophasiaHostViewV0 = realHostViewV0,
): EndophasiaCommandV0 & { projectRoots: { projectId: string; resolvedRoot: string }[] } {
	const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" };
	const endoArgs = [
		config.endo.entry,
		"coordinator",
		"status",
		"--quiet",
		"--root",
		config.storeRoot,
		"--stale-after",
		String(config.staleAfterSeconds ?? ENDOPHASIA_STATUS_LIMITS_V0.defaultStaleAfterSeconds),
		...projectIds.flatMap((id) => ["--project", id]),
	];
	const ro = (path: string) => ["--ro-bind", path, path];
	const roTry = (path: string) => ["--ro-bind-try", path, path];
	const system = SYSTEM_LINKS.flatMap((p) => {
		const target = host.link(p);
		return target === null ? roTry(p) : ["--symlink", target, p];
	});
	const node = host.real(config.endo.node);
	const roots = config.projects
		.filter((p) => projectIds.includes(p.id))
		.map((p) => {
			const configuredRoot = resolve(p.root);
			const resolvedRoot = host.real(configuredRoot);
			const fromParent = relative(host.real(dirname(configuredRoot)), resolvedRoot);
			if (
				resolvedRoot === "/" ||
				fromParent === "" ||
				fromParent === ".." ||
				fromParent.startsWith(`..${sep}`) ||
				isAbsolute(fromParent)
			)
				throw new ProjectRootError();
			const git = join(resolvedRoot, ".git");
			const kind = host.kind(git);
			if (kind === "other" || (kind === "directory" && host.kind(join(git, "commondir")) !== "missing"))
				throw new ProjectGitLayoutError();
			return { projectId: p.id, configuredRoot, resolvedRoot };
		});
	return {
		file: config.bwrapPath ?? "/usr/bin/bwrap",
		projectRoots: roots.map(({ projectId, resolvedRoot }) => ({ projectId, resolvedRoot })),
		args: [
			"--die-with-parent",
			"--new-session",
			"--unshare-all",
			"--tmpfs",
			"/tmp",
			...ro("/usr"),
			...system,
			...SYSTEM_FILES.flatMap(roTry),
			...(node.startsWith("/usr/") ? [] : ro(dirname(dirname(node)))),
			...ro(codeRootOf(config.endo.entry, host)),
			...STORE_DIRS.flatMap((d) => roTry(join(config.storeRoot, d))),
			...roots.flatMap(({ configuredRoot, resolvedRoot }) =>
				configuredRoot === resolvedRoot
					? ro(resolvedRoot)
					: [...ro(resolvedRoot), "--symlink", resolvedRoot, configuredRoot],
			),
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--chdir",
			"/",
			"--clearenv",
			...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
			"--",
			config.endo.node,
			...endoArgs,
		],
		env,
	};
}

export type EndophasiaStatusReadV0 =
	| {
			availability: "available";
			status: EndoCoordinatorStatusV0;
			durationMs: number;
			projectRoots: ReturnType<typeof endophasiaStatusCommandV0>["projectRoots"];
	  }
	| {
			availability: "unavailable";
			reason:
				| "project-git-layout-refused"
				| "project-root-refused"
				| "spawn-failed"
				| "timed-out"
				| "output-too-large"
				| "exited-nonzero"
				| "not-json"
				| "invalid-status";
			detail: string;
			durationMs: number;
	  };

export type EndophasiaRunV0 = (
	command: EndophasiaCommandV0,
	options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
) => Promise<{ code: number | null; signal: string | null; stdout: string; error: string | null }>;

/** Run with execFile: no shell, the given environment only, killed on timeout, stdout bounded. */
export const execEndophasiaV0: EndophasiaRunV0 = (command, options) =>
	new Promise((resolve) => {
		execFile(
			command.file,
			command.args,
			{
				env: command.env,
				shell: false,
				timeout: options.timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: options.maxBytes,
				windowsHide: true,
				encoding: "utf8",
				...(options.signal === undefined ? {} : { signal: options.signal }),
			},
			(error, stdout) => {
				if (error === null) return resolve({ code: 0, signal: null, stdout, error: null });
				const e = error as NodeJS.ErrnoException & { code?: number | string; signal?: string; killed?: boolean };
				const kind =
					e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
						? "output-too-large"
						: e.killed === true || e.signal === "SIGKILL"
							? "timed-out"
							: typeof e.code === "string"
								? "spawn-failed"
								: null;
				resolve({
					code: typeof e.code === "number" ? e.code : null,
					signal: e.signal ?? null,
					stdout,
					error: kind,
				});
			},
		);
	});

/** One status read. Never throws for an Endophasia-side problem: that is reported as `unavailable` with a closed reason. */
export async function readEndophasiaStatusV0(
	config: EndophasiaStatusConfigV0,
	projectIds: readonly string[],
	options: { run?: EndophasiaRunV0; signal?: AbortSignal; now?: () => number; host?: EndophasiaHostViewV0 } = {},
): Promise<EndophasiaStatusReadV0> {
	const now = options.now ?? Date.now;
	const started = now();
	let command: ReturnType<typeof endophasiaStatusCommandV0>;
	try {
		command = endophasiaStatusCommandV0(config, projectIds, options.host);
	} catch (error) {
		return {
			availability: "unavailable",
			reason:
				error instanceof ProjectRootError
					? "project-root-refused"
					: error instanceof ProjectGitLayoutError
						? "project-git-layout-refused"
						: "spawn-failed",
			detail:
				error instanceof ProjectRootError
					? "the configured project root resolves outside its parent directory"
					: error instanceof ProjectGitLayoutError
						? "Git metadata indirection is unsupported; only a project with its Git directory inside its configured root can be read"
						: "sandbox paths could not be checked",
			durationMs: now() - started,
		};
	}
	const ran = await (options.run ?? execEndophasiaV0)(command, {
		timeoutMs: config.timeoutMs ?? ENDOPHASIA_STATUS_LIMITS_V0.defaultTimeoutMs,
		maxBytes: ENDOPHASIA_STATUS_LIMITS_V0.maxStdoutBytes,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	const durationMs = now() - started;
	const unavailable = (
		reason: Extract<EndophasiaStatusReadV0, { availability: "unavailable" }>["reason"],
		detail: string,
	) => ({ availability: "unavailable", reason, detail, durationMs }) as const;
	if (ran.error === "spawn-failed") return unavailable("spawn-failed", "the status command could not be started");
	if (ran.error === "timed-out")
		return unavailable("timed-out", "the status command did not finish in time and was killed");
	if (ran.error === "output-too-large") return unavailable("output-too-large", "the status output exceeded its bound");
	if (ran.code !== 0)
		return unavailable("exited-nonzero", `the status command exited with ${ran.code ?? ran.signal ?? "unknown"}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(ran.stdout);
	} catch {
		return unavailable("not-json", "the status command did not print one JSON document");
	}
	try {
		const status = validateEndoCoordinatorStatusV0((parsed as { coordinatorStatus?: unknown }).coordinatorStatus);
		const asked = [...projectIds].sort().join(",");
		if (status.scope.requested === null || [...status.scope.requested].sort().join(",") !== asked)
			return unavailable("invalid-status", "the returned scope does not match the projects asked for");
		return { availability: "available", status, durationMs, projectRoots: command.projectRoots };
	} catch (error) {
		return unavailable("invalid-status", error instanceof Error ? error.message.slice(0, 200) : "invalid status");
	}
}

const ago = (ms: number | null) => {
	if (ms === null) return "age unknown";
	const m = Math.round(ms / 60_000);
	if (m < 2) return "just now";
	if (m < 120) return `${m} min ago`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/**
 * What the tool returns by default: only what a status answer needs. No check command strings (they carry argv), no commit ids, no
 * project names from the task file (the operator's label or the opaque id instead), no session or runtime identifiers, no event ids, no
 * finding prose (it names sessions and commands), and no store-wide counts of sessions outside the asked-for projects. Task titles are
 * included only with `disclose.taskTitles`; the whole validated status only with `disclose.detail`.
 */
export interface EndophasiaExternalStatusV0 {
	schemaVersion: string;
	readAtMs: number;
	sources: Record<"tasks" | "attempts" | "events", { state: string; freshness: string }>;
	projects: {
		project: string;
		freshness: string;
		head: "clean" | "uncommitted-changes" | "not-observed";
		counts: Record<string, number>;
		tasks: {
			taskId: string;
			title?: string;
			phase: string;
			verification: {
				state: string;
				freshness: string;
				incomplete: boolean;
				results: { outcome: string; relation: string | null }[];
				moreResults: number;
			};
			gaps: string[];
			association: string;
			linkedSessions: number;
		}[];
	}[];
	sessions: {
		observation: string;
		recordedState: string;
		stateBasis: string;
		freshness: string;
		lastEventAgeMs: number | null;
		linkedTasks: string[];
		lastRun: null | { outcome: string; basis: string };
	}[];
	attention: { kind: string; taskId: string | null }[];
	findings: { code: string; severity: string }[];
}

export function externalEndophasiaStatusV0(
	status: EndoCoordinatorStatusV0,
	config: EndophasiaStatusConfigV0,
): EndophasiaExternalStatusV0 {
	const label = new Map(config.projects.map((p) => [p.id, p.label ?? p.id] as const));
	const titles = config.disclose?.taskTitles === true;
	const taskIds = new Set(status.projects.flatMap((p) => p.tasks.map((t) => t.taskId)));
	const src = status.sources;
	const source = (x: (typeof src)["tasks"]) => ({ state: x.state, freshness: x.freshness.state });
	return {
		schemaVersion: status.schemaVersion,
		readAtMs: status.readAtMs,
		sources: { tasks: source(src.tasks), attempts: source(src.attempts), events: source(src.events) },
		projects: status.projects.map((p) => ({
			project: label.get(p.id) ?? p.id,
			freshness: p.freshness.state,
			head: p.head === null ? "not-observed" : p.head.clean ? "clean" : "uncommitted-changes",
			counts: { ...p.counts },
			tasks: p.tasks.map((t) => ({
				taskId: t.taskId,
				...(titles ? { title: t.title } : {}),
				phase: t.phase,
				verification: {
					state: t.verification.state,
					freshness: t.verification.freshness.state,
					incomplete: t.verification.incomplete,
					results: t.verification.results.map(({ outcome, relation }) => ({ outcome, relation })),
					moreResults: t.verification.moreResults,
				},
				gaps: t.gaps.map((g) => g.code),
				association: t.association,
				linkedSessions: t.sessions.length,
			})),
		})),
		sessions: status.sessions
			.filter((x) => x.association === "explicit")
			.map((x) => ({
				observation: x.observation,
				recordedState: x.recordedState,
				stateBasis: x.stateBasis,
				freshness: x.freshness.state,
				lastEventAgeMs: x.freshness.ageMs,
				linkedTasks: [...new Set(x.links.map((l) => l.taskId))],
				lastRun: x.lastRun === null ? null : { outcome: x.lastRun.outcome, basis: x.lastRun.basis },
			})),
		attention: status.attention.map((a) => ({
			kind: a.kind,
			taskId: a.subject !== null && taskIds.has(a.subject) ? a.subject : null,
		})),
		findings: status.findings.map((f) => ({ code: f.code, severity: f.severity })),
	};
}

/** The validated status with task titles withheld unless the operator chose to disclose them (`disclose.detail` only). */
export function redactEndophasiaStatusV0(
	status: EndoCoordinatorStatusV0,
	config: EndophasiaStatusConfigV0,
): EndoCoordinatorStatusV0 {
	if (config.disclose?.taskTitles === true) return status;
	return {
		...status,
		projects: status.projects.map((p) => ({ ...p, tasks: p.tasks.map((t) => ({ ...t, title: "[not disclosed]" })) })),
	};
}

/**
 * A plain-language answer for "what's happening, what needs me, which sessions are active?", qualified at every step: who says so,
 * how fresh it is, and what is not known. Built from the external view only, so it cannot say more than the tool returns.
 */
export function summariseEndophasiaStatusV0(view: EndophasiaExternalStatusV0): string {
	const lines: string[] = [];
	lines.push(
		`Endophasia status, read-only, read at ${new Date(view.readAtMs).toISOString()} (${view.schemaVersion}). Task status is the operator's own record; checks are controller-observed host checks; a recorded report is the operator's record that a report exists, not a verified result.`,
	);
	lines.push(
		"Check results describe the records present, not an overall task pass; the store cannot show whether a later receipt is missing.",
	);
	const s = view.sources;
	lines.push(
		`Sources: task file ${s.tasks.state}/${s.tasks.freshness}; attempt records ${s.attempts.state}/${s.attempts.freshness}; event log ${s.events.state}/${s.events.freshness}.`,
	);
	for (const p of view.projects) {
		const c = p.counts;
		lines.push(
			`Project ${p.project}, HEAD ${p.head} [${p.freshness}]: ${c["awaiting-review"]} awaiting review, ${c["in-progress"]} in progress, ${c.blocked} blocked, ${c.open} open, ${c.completed} completed.`,
		);
		for (const t of p.tasks) {
			const name = t.title === undefined ? t.taskId : `"${t.title}" (${t.taskId})`;
			const gaps = t.gaps.length === 0 ? "no evidence gaps" : `gaps: ${t.gaps.join(", ")}`;
			if (t.phase === "completed") {
				lines.push(`- [completed] ${name}: ${gaps}.`);
				continue;
			}
			const sessions =
				t.association === "explicit"
					? `${t.linkedSessions} linked session record(s)`
					: "no session is linked by any record (relationship unknown)";
			lines.push(
				`- [${t.phase}] ${name}: verification ${t.verification.state} [${t.verification.freshness}${t.verification.incomplete && t.verification.freshness !== "incomplete" ? ", incomplete" : ""}]; ${gaps}; ${sessions}.`,
			);
		}
	}
	if (view.attention.length === 0) lines.push("Needs your attention: nothing flagged by these records.");
	else
		lines.push(
			`Needs your attention (advisory, not acceptance): ${view.attention.map((a) => (a.taskId === null ? a.kind : `${a.kind} (${a.taskId})`)).join("; ")}.`,
		);
	const active = view.sessions.filter((x) => x.observation === "active");
	lines.push(
		`Agent sessions explicitly linked to these projects' tasks: ${view.sessions.length}, of which ${active.length} active. Sessions with no recorded link to these projects are not counted in this answer.`,
	);
	for (const x of view.sessions)
		lines.push(
			`- [${x.observation}] linked to ${x.linkedTasks.join(", ")}: recorded ${x.recordedState} (${x.stateBasis}) [${x.freshness}], last event ${ago(x.lastEventAgeMs)}; last run ${x.lastRun === null ? "none" : `${x.lastRun.outcome} (${x.lastRun.basis})`}.`,
		);
	const findings = view.findings.filter((f) => f.severity !== "info");
	if (findings.length > 0) lines.push(`Findings: ${findings.map((f) => `${f.code} [${f.severity}]`).join("; ")}.`);
	lines.push(
		"Not established: whether any session is alive now (there is no liveness probe), or which task an unlinked session worked on.",
	);
	return lines.join("\n");
}
