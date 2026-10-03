// Pi's behaviour-relevant user configuration, as a digest that capability evidence depends on.
//
// The runtime fingerprint (identity.ts) identifies the installed program. What that program does also depends on its
// user configuration (Pi 1.0.0 docs/configuration.md): settings, model endpoints, MCP servers, system-prompt and
// instruction files, extensions, skills and prompt templates in the agent directory (PI_CODING_AGENT_DIR, default
// ~/.pi/agent), plus PI_* environment switches. A change there can change what a capability does, so evidence recorded
// under one configuration does not apply under another (evidence.ts, rule 6).
//
// Excluded on purpose: auth.json (credentials, which rotate without changing behaviour, and must never be read into a
// record), keybindings.json and themes/ (presentation only), sessions, and environment variables that hold keys or
// tokens. The digest is read-only: nothing here writes to Pi's configuration.
//
// Project configuration (`.pi/` under the working directory) is digested separately (piProjectConfigurationDigestV0)
// and recorded with each session: the checks run in scratch directories without it, so evidence never covers a
// project's own extensions or settings.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const AGENT_FILES = [
	"settings.json",
	"mcp.json",
	"models.json",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
];
const AGENT_DIRECTORIES = ["extensions", "skills", "prompts"];
const PROJECT_FILES = ["settings.json", "mcp.json", "SYSTEM.md", "APPEND_SYSTEM.md"];
const PROJECT_DIRECTORIES = ["extensions", "skills", "prompts"];
/** Environment switches that do not change agent behaviour, or that the adapter itself sets for checks. */
const IGNORED_ENV = new Set(["PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_HARDWARE_CURSOR"]);
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const MAX_ENTRIES = 5000;
const MAX_BYTES = 64 * 1024 * 1024;

interface Walk {
	hash: ReturnType<typeof createHash>;
	entries: number;
	bytes: number;
	bounded: boolean;
}

function add(walk: Walk, label: string, path: string): void {
	if (walk.entries >= MAX_ENTRIES || walk.bytes >= MAX_BYTES) {
		walk.bounded = true;
		return;
	}
	walk.entries += 1;
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(path);
	} catch {
		walk.hash.update(`${label}\0absent\n`);
		return;
	}
	if (info.isSymbolicLink()) {
		// The link target is recorded, never followed: a link cannot make the walk loop or escape its bounds.
		walk.hash.update(`${label}\0link\0${readlinkSync(path)}\n`);
		return;
	}
	if (info.isDirectory()) {
		walk.hash.update(`${label}\0dir\n`);
		let names: string[];
		try {
			names = readdirSync(path).sort();
		} catch {
			walk.hash.update(`${label}\0unreadable\n`);
			return;
		}
		for (const name of names) add(walk, `${label}/${name}`, join(path, name));
		return;
	}
	if (!info.isFile()) {
		walk.hash.update(`${label}\0other\n`);
		return;
	}
	walk.bytes += info.size;
	if (walk.bytes > MAX_BYTES) {
		walk.bounded = true;
		walk.hash.update(`${label}\0file-over-bound\0${info.size}\n`);
		return;
	}
	try {
		walk.hash.update(`${label}\0file\0${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
	} catch {
		walk.hash.update(`${label}\0unreadable\n`);
	}
}

/** The agent directory Pi would use under `env`. */
export function piAgentDirectoryV0(env: Readonly<Record<string, string | undefined>>): string | null {
	if (env.PI_CODING_AGENT_DIR !== undefined && env.PI_CODING_AGENT_DIR.length > 0) return env.PI_CODING_AGENT_DIR;
	if (env.HOME !== undefined && env.HOME.length > 0) return join(env.HOME, ".pi", "agent");
	return null;
}

/**
 * SHA-256 over Pi's behaviour-relevant user configuration under `env`: the listed agent-directory files and
 * directories (content digests, symlink targets, absences) and the PI_* switches that are neither ignored nor secret.
 * Deterministic for equal configurations. A walk that hits its bounds is marked in the digest, so a bounded digest
 * never equals an unbounded one.
 */
export function piUserConfigurationDigestV0(env: Readonly<Record<string, string | undefined>>): string {
	const walk: Walk = { hash: createHash("sha256"), entries: 0, bytes: 0, bounded: false };
	walk.hash.update("pi-user-configuration.v1\n");
	const directory = piAgentDirectoryV0(env);
	if (directory === null) walk.hash.update("agent-dir\0unknown\n");
	else {
		for (const file of AGENT_FILES) add(walk, file, join(directory, file));
		for (const name of AGENT_DIRECTORIES) add(walk, name, join(directory, name));
	}
	for (const key of Object.keys(env).sort()) {
		if (!key.startsWith("PI_") || IGNORED_ENV.has(key) || SECRET_ENV.test(key) || key === "PI_CODING_AGENT_DIR")
			continue;
		walk.hash.update(`env\0${key}\0${env[key] ?? ""}\n`);
	}
	if (walk.bounded) walk.hash.update("bounded\n");
	return walk.hash.digest("hex");
}

/** SHA-256 over the project configuration Pi would load from `<cwd>/.pi` (recorded per session, not in evidence). */
export function piProjectConfigurationDigestV0(cwd: string): string {
	const walk: Walk = { hash: createHash("sha256"), entries: 0, bytes: 0, bounded: false };
	walk.hash.update("pi-project-configuration.v1\n");
	for (const file of PROJECT_FILES) add(walk, file, join(cwd, ".pi", file));
	for (const name of PROJECT_DIRECTORIES) add(walk, name, join(cwd, ".pi", name));
	if (walk.bounded) walk.hash.update("bounded\n");
	return walk.hash.digest("hex");
}
