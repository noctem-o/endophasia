// The read-only Endophasia status reader the OpenClaw plugin runs (docs/designs/coordinator-status.md §OpenClaw).
//
// It runs ONE fixed command, `endo coordinator status --quiet --root <storeRoot> --project <id>...`, with an argv built only from the
// operator's plugin config: the model chooses at most which permitted project to ask about, never a path, a flag or a command. No shell,
// a scrubbed environment (the gateway's provider credentials never reach the child), a timeout, an output bound, and always a
// bubblewrap sandbox with the whole filesystem read-only, no network, and the gateway's own credential stores masked. There is no
// unsandboxed mode: if bubblewrap is missing or cannot start, the read is `unavailable` and endo never runs. What comes back is
// validated against the protocol's own validator before anything is relayed; another schema version is refused, not guessed at.
//
// This module has no OpenClaw or TypeBox import, so it is tested directly (tests/openclaw-endophasia-status.test.ts).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	ENDO_COORDINATOR_STATUS_SCHEMA_V0,
	type EndoCoordinatorStatusV0,
	validateEndoCoordinatorStatusV0,
} from "../../../protocol/coordinator-status.ts";

export interface EndophasiaStatusConfigV0 {
	endo: { node: string; entry: string };
	storeRoot: string;
	projects: { id: string; label?: string }[];
	staleAfterSeconds?: number;
	timeoutMs?: number;
	bwrapPath?: string;
	disclose?: { taskTitles?: boolean };
}

export const ENDOPHASIA_STATUS_LIMITS_V0 = Object.freeze({
	defaultTimeoutMs: 20_000,
	maxTimeoutMs: 60_000,
	maxStdoutBytes: 4 * 1024 * 1024,
	maxProjects: 8,
	defaultStaleAfterSeconds: 600,
});

const PROJECT_ID = /^endo\.project\.[0-9a-f]{32}$/;
/** Credential stores masked (empty tmpfs) inside the sandbox when they exist: the reader needs none of them. */
const MASKED_HOME_DIRS = [".openclaw", ".pi", ".ssh", ".gnupg", ".config/Capy"];

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
		for (const key of Object.keys(d)) if (key !== "taskTitles") bad(`unknown disclose key ${key}`);
		if (d.taskTitles !== undefined && typeof d.taskTitles !== "boolean") bad("disclose.taskTitles must be a boolean");
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

/** The exact command, built from config only. `home` is the gateway user's home (masking and git's global ignore file). */
export function endophasiaStatusCommandV0(
	config: EndophasiaStatusConfigV0,
	projectIds: readonly string[],
	home: string = homedir(),
	exists: (path: string) => boolean = existsSync,
): EndophasiaCommandV0 {
	const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" };
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
	const masks = MASKED_HOME_DIRS.map((d) => join(home, d)).filter((p) => exists(p));
	return {
		file: config.bwrapPath ?? "/usr/bin/bwrap",
		args: [
			"--die-with-parent",
			"--new-session",
			"--unshare-all",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			...masks.flatMap((m) => ["--tmpfs", m]),
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
	| { availability: "available"; status: EndoCoordinatorStatusV0; durationMs: number }
	| {
			availability: "unavailable";
			reason: "spawn-failed" | "timed-out" | "output-too-large" | "exited-nonzero" | "not-json" | "invalid-status";
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
	options: { run?: EndophasiaRunV0; signal?: AbortSignal; now?: () => number; home?: string } = {},
): Promise<EndophasiaStatusReadV0> {
	const now = options.now ?? Date.now;
	const started = now();
	const command = endophasiaStatusCommandV0(config, projectIds, options.home);
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
		return { availability: "available", status, durationMs };
	} catch (error) {
		return unavailable("invalid-status", error instanceof Error ? error.message.slice(0, 200) : "invalid status");
	}
}

const iso = (ms: number | null) => (ms === null ? "unknown time" : new Date(ms).toISOString());
const ago = (ms: number | null) => {
	if (ms === null) return "age unknown";
	const m = Math.round(ms / 60_000);
	if (m < 2) return "just now";
	if (m < 120) return `${m} min ago`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** Hide what the operator did not choose to disclose (task titles are their private words), keeping every evidential field. */
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
 * how fresh it is, and what is not known. Built from the validated status only.
 */
export function summariseEndophasiaStatusV0(status: EndoCoordinatorStatusV0, config: EndophasiaStatusConfigV0): string {
	const label = new Map(config.projects.map((p) => [p.id, p.label] as const));
	const titles = config.disclose?.taskTitles === true;
	const name = (t: { taskId: string; title: string }) => (titles ? `"${t.title}" (${t.taskId})` : t.taskId);
	const lines: string[] = [];
	lines.push(
		`Endophasia status, read-only, read at ${iso(status.readAtMs)} (${ENDO_COORDINATOR_STATUS_SCHEMA_V0}). Task status is the operator's own record; checks are controller-observed host checks; anything an agent reported is unverified.`,
	);
	const s = status.sources;
	lines.push(
		`Sources: task file ${s.tasks.state}/${s.tasks.freshness.state}; attempt records ${s.attempts.state}/${s.attempts.freshness.state}; event log ${s.events.state}/${s.events.freshness.state}.`,
	);
	for (const p of status.projects) {
		const head =
			p.head === null
				? "HEAD not observed"
				: `HEAD ${p.head.commit.slice(0, 12)}${p.head.clean ? " (clean)" : " (uncommitted changes)"}`;
		const c = p.counts;
		lines.push(
			`Project ${label.get(p.id) ?? p.name} (${p.id}), ${head} [${p.freshness.state}]: ${c["awaiting-review"]} awaiting review, ${c["in-progress"]} in progress, ${c.blocked} blocked, ${c.open} open, ${c.completed} completed.`,
		);
		for (const t of p.tasks) {
			if (t.phase === "completed") continue;
			const sessions =
				t.association === "explicit"
					? `linked sessions: ${t.sessions.map((l) => `${l.sessionId} (${l.via}, ${l.basis})`).join(", ")}`
					: "no session is linked by any record (relationship unknown)";
			const latest = t.attempts.latest === null ? "no attempt" : `latest attempt ${t.attempts.latest.state}`;
			const gaps = t.gaps.length === 0 ? "no evidence gaps" : `gaps: ${t.gaps.map((g) => g.code).join(", ")}`;
			lines.push(
				`- [${t.phase}] ${name(t)}: verification ${t.verification.state} [${t.verification.freshness.state}${t.verification.incomplete ? ", incomplete" : ""}]; ${latest}; ${gaps}; ${sessions}.`,
			);
		}
	}
	if (status.attention.length === 0) lines.push("Needs your attention: nothing flagged by these records.");
	else {
		lines.push("Needs your attention (advisory, not acceptance):");
		for (const a of status.attention) lines.push(`- [${a.kind}] ${a.text}`);
	}
	const active = status.sessions.filter((x) => x.observation === "active");
	const u = status.unlistedSessions;
	lines.push(
		`Agent sessions: ${active.length} active among those linked to these projects; ${u.unknownRelationship} more session(s) in the store have no recorded relationship to them (${u.active} of those active, not listed).`,
	);
	for (const x of status.sessions)
		lines.push(
			`- [${x.observation}] ${x.sessionId}: recorded ${x.recordedState} [${x.freshness.state}], last event ${ago(x.freshness.ageMs)}; last run ${x.lastRun === null ? "none" : `${x.lastRun.outcome} (${x.lastRun.basis})`}.`,
		);
	for (const f of status.findings) if (f.severity !== "info") lines.push(`Finding [${f.severity}]: ${f.text}`);
	lines.push(`Not established: ${status.notEstablished[0]} ${status.notEstablished[1]}`);
	return lines.join("\n");
}
