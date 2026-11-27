// Reusable host-capability and executable-requirement test helpers (CI-RELIABILITY-001, B4).
//
// Tests that require optional host tools (e.g., an installed OpenClaw or Pi binary, /usr/bin/bwrap, or Chromium)
// must never fall back to hardcoded workstation home paths like `/home/<user>/.local/bin/...` or rely on
// ambient HOME/XDG state. Use these helpers so missing host capabilities are detected explicitly and either
// skipped cleanly (opt-in) or failed loudly when the matching CI requirement variable is set to "1".

import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

export interface CapabilityCheckV0 {
	readonly available: boolean;
	readonly path: string | null;
	readonly reason?: string;
}

export interface CapabilityGateV0 {
	readonly run: boolean;
	readonly required: boolean;
	readonly available: boolean;
	readonly reason?: string;
}

/**
 * Returns true if `filePath` is an existing regular executable file on this host.
 * Rejects empty strings, directories, and non-executable paths without throwing.
 */
export function hasExecutableV0(filePath: string | null | undefined): boolean {
	if (!filePath || filePath.trim() === "") return false;
	try {
		if (!statSync(filePath).isFile()) return false;
		accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves an optional executable strictly from an explicit environment variable.
 * Never falls back to workstation-specific user home directories.
 */
export function resolveOptionalExecutableV0(envVar: string, env: NodeJS.ProcessEnv = process.env): CapabilityCheckV0 {
	const raw = env[envVar]?.trim();
	if (!raw) {
		return { available: false, path: null, reason: `${envVar} is not set` };
	}
	if (!hasExecutableV0(raw)) {
		return { available: false, path: raw, reason: `${envVar}=${raw} is not an executable file` };
	}
	return { available: true, path: raw };
}

/**
 * Probes whether Bubblewrap (`/usr/bin/bwrap` by default) is present and optionally whether this host
 * allows unprivileged user namespaces (`--unshare-user`).
 */
export function probeBwrapSandboxV0(
	options: { readonly path?: string; readonly checkUserNamespace?: boolean } = {},
): CapabilityCheckV0 {
	const bwrapPath = options.path ?? "/usr/bin/bwrap";
	if (!hasExecutableV0(bwrapPath)) {
		return { available: false, path: null, reason: `${bwrapPath} is not installed or not executable` };
	}
	if (options.checkUserNamespace) {
		const probe = spawnSync(
			bwrapPath,
			[
				"--unshare-all",
				"--unshare-user",
				"--die-with-parent",
				"--new-session",
				"--cap-drop",
				"ALL",
				"--clearenv",
				"--ro-bind",
				"/usr",
				"/usr",
				"--symlink",
				"usr/lib",
				"/lib",
				"--symlink",
				"usr/lib64",
				"/lib64",
				"--remount-ro",
				"/",
				"--",
				"/usr/bin/true",
			],
			{ encoding: "utf8", timeout: 5_000 },
		);
		if (probe.status !== 0) {
			return {
				available: false,
				path: bwrapPath,
				reason: `user-namespace probe failed (${probe.stderr?.trim() || `exit ${probe.status}`})`,
			};
		}
	}
	return { available: true, path: bwrapPath };
}

/**
 * Standardizes Endophasia's opt-in-or-require capability gate (matching `ENDO_REQUIRE_BROWSER` and
 * `ENDO_REQUIRE_TRUST_SANDBOX`):
 * - If `available` is true: `{ run: true, required, available: true }`.
 * - If `available` is false and `env[requireEnvVar] === "1"`: throws an actionable error instead of silently skipping.
 * - Otherwise: `{ run: false, required: false, available: false, reason }`.
 */
export function requireOrSkipCapabilityV0(
	capabilityName: string,
	requireEnvVar: string,
	check: CapabilityCheckV0,
	env: NodeJS.ProcessEnv = process.env,
): CapabilityGateV0 {
	const required = env[requireEnvVar] === "1";
	if (check.available) {
		return { run: true, required, available: true };
	}
	const detail = check.reason ?? `${capabilityName} is unavailable on this host`;
	if (required) {
		throw new Error(`${capabilityName} is required (${requireEnvVar}=1) but unavailable: ${detail}`);
	}
	return { run: false, required: false, available: false, reason: detail };
}

/**
 * Builds an isolated child-process environment anchored under `rootDir` so tests never read or mutate
 * the developer's ambient `HOME`, `XDG_*`, or systemd user session unless real scopes are explicitly requested.
 */
export function isolatedHomeEnvV0(
	rootDir: string,
	options: {
		readonly baseEnv?: NodeJS.ProcessEnv;
		readonly allowRealScopes?: boolean;
		readonly extra?: Record<string, string>;
	} = {},
): NodeJS.ProcessEnv {
	const base = options.baseEnv ?? process.env;
	const home = join(rootDir, "home");
	const env: NodeJS.ProcessEnv = {
		...base,
		HOME: home,
		XDG_CONFIG_HOME: join(rootDir, "xdg-config"),
		XDG_DATA_HOME: join(rootDir, "xdg-data"),
		XDG_STATE_HOME: join(rootDir, "xdg-state"),
		XDG_CACHE_HOME: join(rootDir, "xdg-cache"),
		...options.extra,
	};
	if (!options.allowRealScopes && base.ENDO_REAL_SCOPES !== "1") {
		env.XDG_RUNTIME_DIR = "";
		env.DBUS_SESSION_BUS_ADDRESS = "";
	}
	return env;
}

/**
 * Returns true if `candidate` begins with a user home directory prefix (`/home/<user>/` or `/Users/<user>/`),
 * independent of the host environment (helpful for guards that reject workstation-specific paths in CI tests).
 */
export function isWorkstationHomePathV0(candidate: string): boolean {
	return /^\/(?:home|Users)\/[^/]+\//.test(candidate);
}
