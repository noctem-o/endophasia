/**
 * Milestone D2 / Remediation — Isolated conservative `CODEX_HOME` boundary established BEFORE spawning `codex app-server`.
 *
 * Empirical finding on `codex-cli 0.171.0`:
 * 1. Disabling inherited MCP servers only on `thread/start` is insufficient: built-in MCP servers (`cua_repl` via
 *    `features.computer_use`, `codex_apps` via `features.apps`) still start unless disabled in startup config, and
 *    pointing `codex app-server` at the operator's `~/.codex` mutates SQLite WAL/config timestamps and exposes
 *    inherited `config.toml`, `hooks.json`, `plugins/`, and `skills/`.
 * 2. Even when `codex app-server` emits a `configWarning` stating project-local `.codex/config.toml` is disabled until
 *    trusted, `thread/start` in `0.171.0` still starts MCP servers defined in an untrusted project `.codex/config.toml`
 *    unless that project path is explicitly marked `trust_level = "untrusted"` in `config.toml`.
 *
 * Solution:
 * - Create an ephemeral `0o700` `CODEX_HOME` directory before process spawn with a minimal conservative `config.toml`.
 * - Explicitly mark `cwd` and every ancestor containing `.codex` as `trust_level = "untrusted"`.
 * - Preserve supported authentication WITHOUT extracting or reading credentials: if `<sourceCodexHome>/auth.json`
 *   exists, symlink it into the isolated home; environment variables (e.g. `OPENAI_API_KEY`) and keyring remain intact.
 * - Never modify the operator's normal `~/.codex` configuration.
 * - Verify `initialize.codexHome` matches the isolated home fail-closed before continuing.
 */

import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CODEX_ALLOWED_SANDBOX_MODES_V0 = ["workspace-write", "read-only"] as const;
export type CodexSandboxModeV0 = (typeof CODEX_ALLOWED_SANDBOX_MODES_V0)[number];

/** Strictly allowlist Codex sandbox modes (`workspace-write` or `read-only` only; never `danger-full-access`). */
export function validateCodexSandboxModeV0(raw: unknown): CodexSandboxModeV0 {
	if (raw === "workspace-write" || raw === "read-only") return raw;
	throw new TypeError(
		`Invalid Codex sandboxMode ${JSON.stringify(raw)}; expected one of: ${CODEX_ALLOWED_SANDBOX_MODES_V0.join(", ")}`,
	);
}

function tomlBasicString(value: string): string {
	if (/[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(
			"Path contains control characters and cannot be safely written to isolated Codex config.toml",
		);
	}
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizePath(pathStr: string): string {
	try {
		return realpathSync(pathStr);
	} catch {
		return resolve(pathStr);
	}
}

/**
 * Collect `cwd` (both logical `resolve(cwd)` and physical `realpathSync(cwd)`) plus every ancestor along either
 * chain containing a `.codex` or `.git` marker so neither symlinked project roots nor ancestor `.codex/config.toml`
 * layers can leak project-local MCP servers or hooks into Codex.
 */
function collectUntrustedProjectPaths(cwd: string): string[] {
	const logicalCwd = resolve(cwd);
	const physicalCwd = normalizePath(cwd);
	const out = new Set<string>([logicalCwd, physicalCwd]);
	for (const start of [logicalCwd, physicalCwd]) {
		let current = start;
		for (;;) {
			if (existsSync(join(current, ".codex")) || existsSync(join(current, ".git"))) {
				out.add(current);
			}
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	return [...out].sort();
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export interface PrepareCodexIsolatedHomeOptionsV0 {
	/** Optional Endophasia store root; when provided, isolated home is placed under `<root>/tmp/`. */
	readonly root?: string;
	/** Workspace `cwd` for the Codex session/check (explicitly marked `trust_level = "untrusted"`). */
	readonly cwd: string;
	/** Conservative sandbox mode (`workspace-write` or `read-only`). Default: `workspace-write`. */
	readonly sandboxMode?: CodexSandboxModeV0;
	/** Base child environment (used to preserve `PATH`, `HOME`, `OPENAI_API_KEY`, etc.). */
	readonly baseEnv?: Readonly<Record<string, string>>;
	/** Source Codex home directory used ONLY to check/symlink `auth.json` (never modified or read). */
	readonly sourceCodexHome?: string;
	/** Whether to symlink `<sourceCodexHome>/auth.json` when present. Default: `true`. */
	readonly linkAuth?: boolean;
}

export interface PreparedCodexIsolatedHomeV0 {
	readonly dir: string;
	readonly realDir: string;
	readonly configPath: string;
	readonly authLinked: boolean;
	readonly sandboxMode: CodexSandboxModeV0;
	readonly untrustedProjectPaths: readonly string[];
	readonly childEnv: Readonly<Record<string, string>>;
	readonly cleanup: () => void;
}

/** Create an ephemeral isolated `CODEX_HOME` with conservative startup configuration before spawning `codex app-server`. */
export function prepareCodexIsolatedHomeV0(options: PrepareCodexIsolatedHomeOptionsV0): PreparedCodexIsolatedHomeV0 {
	const sandboxMode = validateCodexSandboxModeV0(options.sandboxMode ?? "workspace-write");
	let dir: string;
	if (options.root !== undefined) {
		const tmpRoot = join(options.root, "tmp");
		mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
		dir = join(tmpRoot, `codex-home-${randomBytes(8).toString("hex")}`);
		mkdirSync(dir, { mode: 0o700 });
	} else {
		dir = mkdtempSync(join(tmpdir(), "endo-codex-home-"));
	}

	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup of ephemeral isolated home directory.
		}
	};

	try {
		const realDir = normalizePath(dir);
		const baseEnv: Record<string, string> =
			options.baseEnv !== undefined
				? { ...options.baseEnv }
				: Object.fromEntries(
						Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
					);

		// When `options.baseEnv` is explicitly provided, do NOT leak the host process's `process.env.CODEX_HOME`.
		// Treat empty strings as unset so `join("", "auth.json")` never resolves a relative `./auth.json`.
		const envCodexHome =
			options.baseEnv !== undefined ? nonEmpty(baseEnv.CODEX_HOME) : nonEmpty(process.env.CODEX_HOME);
		const envHome = nonEmpty(baseEnv.HOME) ?? nonEmpty(homedir());
		const sourceCodexHome =
			nonEmpty(options.sourceCodexHome) ??
			envCodexHome ??
			(envHome !== undefined ? join(envHome, ".codex") : undefined);

		let authLinked = false;
		if (options.linkAuth !== false && sourceCodexHome !== undefined) {
			const sourceAuthPath = join(sourceCodexHome, "auth.json");
			let isRegularFile = false;
			try {
				isRegularFile = statSync(sourceAuthPath).isFile();
			} catch {
				isRegularFile = false;
			}
			if (isRegularFile) {
				// Symlink ONLY — never read, parse, copy, or extract credentials.
				const target = normalizePath(sourceAuthPath);
				symlinkSync(target, join(dir, "auth.json"));
				authLinked = true;
			}
		}

		const untrustedProjectPaths = collectUntrustedProjectPaths(options.cwd);
		const lines: string[] = [
			"# Endophasia isolated conservative Codex startup configuration (ephemeral; never mutates ~/.codex).",
			'approval_policy = "on-request"',
			'approvals_reviewer = "user"',
			`sandbox_mode = ${tomlBasicString(sandboxMode)}`,
			'web_search = "disabled"',
		];
		if (authLinked) {
			lines.push('cli_auth_credentials_store = "file"');
		}
		lines.push(
			"",
			"[sandbox_workspace_write]",
			"network_access = false",
			"writable_roots = []",
			"",
			"[analytics]",
			"enabled = false",
			"",
			"[features]",
			"hooks = false",
			"memories = false",
			"remote_control = false",
			"remote_plugin = false",
			"apps = false",
			"computer_use = false",
			"browser_use = false",
			"browser_use_external = false",
		);
		for (const projectPath of untrustedProjectPaths) {
			lines.push("", `[projects.${tomlBasicString(projectPath)}]`, 'trust_level = "untrusted"');
		}
		lines.push("");

		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, lines.join("\n"), { mode: 0o600 });

		const childEnv: Record<string, string> = {
			...baseEnv,
			CODEX_HOME: realDir,
		};

		return {
			dir,
			realDir,
			configPath,
			authLinked,
			sandboxMode,
			untrustedProjectPaths,
			childEnv,
			cleanup,
		};
	} catch (error) {
		cleanup();
		throw error;
	}
}

/** Fail-closed verification that `initialize.codexHome` matches the isolated `CODEX_HOME` Endophasia prepared. */
export function verifyCodexIsolatedHomeV0(
	reportedCodexHome: string | null | undefined,
	expectedRealDir: string,
): { readonly ok: boolean; readonly reason: string | null } {
	if (typeof reportedCodexHome !== "string" || reportedCodexHome.trim().length === 0) {
		return {
			ok: false,
			reason: "Codex initialize response omitted codexHome; cannot verify isolated startup configuration.",
		};
	}
	const reportedNorm = normalizePath(reportedCodexHome);
	const expectedNorm = normalizePath(expectedRealDir);
	if (reportedNorm !== expectedNorm) {
		return {
			ok: false,
			reason: `Codex reported codexHome "${reportedNorm}" instead of isolated startup home "${expectedNorm}" (fail-closed).`,
		};
	}
	return { ok: true, reason: null };
}
