/**
 * Milestone D2 — Codex runtime discovery and fingerprinting (`endo.harness-fingerprint.v1`).
 *
 * Observes the operator-installed `codex` binary without modifying, installing, or upgrading it:
 * - Resolves explicit path or `codex` on PATH, follows symlinks (`realpath`), hashes the entrypoint file (`sha256`),
 *   checks for a nearby `package.json` or Codex package layout, and runs `<executable> --version` directly (`shell: false`).
 * - Standalone compiled Codex executables (such as `/usr/lib/openai-codex/bin/codex`, ~333 MiB ELF) have no npm
 *   `package.json` and no package-scoped JS runtime-content tree. We preserve `local.runtimeContent = null` with an
 *   explicit `runtimeContent` gap and honest `identity.confidence = "reduced"` (per `protocol/harness.ts` v1 rules).
 *   We NEVER fabricate strong confidence or invent synthetic package manifests to bypass identity guarantees.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
	type EndoHarnessFingerprintFactV1,
	type EndoHarnessFingerprintMethodV1,
	type EndoHarnessFingerprintV1,
	endoHarnessIdentityBasisV1,
	endoHarnessIdentityConfidenceV1,
	validateEndoHarnessFingerprintV1,
} from "../../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

export const CODEX_ADAPTER_VERSION_V0 = "codex-app-server-adapter.1";
export const CODEX_MAPPING_VERSION_V0 = "codex-app-server-mapping.1";
export const CODEX_SUITE_VERSION_V0 = "codex-app-server-suite.1";

export interface CodexExecutableSelectionV0 {
	/** Explicit executable path (absolute, or relative to cwd). Wins over PATH search when set. */
	readonly executable?: string;
	/** Command name searched on PATH when no explicit executable is given. Default: `"codex"`. */
	readonly command?: string;
	/** PATH override. Default: `process.env.PATH`. */
	readonly path?: string;
	/** Base directory for relative explicit paths. Default: `process.cwd()`. */
	readonly cwd?: string;
}

export interface CodexFingerprintOptionsV0 extends CodexExecutableSelectionV0 {
	/** Configured attachment identity, e.g. `codex.default`. */
	readonly attachment: string;
	/** Environment for `--version`. Default: minimal `PATH` and `HOME`. */
	readonly env?: Readonly<Record<string, string>>;
	/** Timeout for `--version`. Default: 15_000 ms. */
	readonly versionTimeoutMs?: number;
	/** Max entrypoint size hashed in bytes. Default: 512 MiB (Codex ELF is ~333 MiB). */
	readonly maxEntrypointBytes?: number;
	/** Clock override for deterministic tests. */
	readonly now?: () => Date;
}

export class CodexFingerprintErrorV0 extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexFingerprintErrorV0";
	}
}

const MAX_VERSION_OUTPUT_BYTES = 4096;
const SEMVER_PATTERN = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/;

/** Parse a semver version from `codex --version` output (e.g. `codex-cli 0.171.0` or `codex-cli 0.171.0-alpha.13`). */
export function parseCodexVersionOutputV0(text: string): string | null {
	const firstLine = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
	if (firstLine.length === 0) return null;
	const match = SEMVER_PATTERN.exec(firstLine);
	return match?.[1] ?? null;
}

async function isExecutableFile(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return false;
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function resolveCodexExecutableV0(selection: CodexExecutableSelectionV0): Promise<{
	requested: string;
	method: "explicit-path" | "path-search";
	resolvedPath: string | null;
	reason?: string;
}> {
	const cwd = selection.cwd ?? process.cwd();
	if (selection.executable !== undefined) {
		if (selection.executable.length === 0) {
			throw new CodexFingerprintErrorV0("the explicit Codex executable path is empty");
		}
		const resolved = isAbsolute(selection.executable) ? selection.executable : resolve(cwd, selection.executable);
		if (await isExecutableFile(resolved)) {
			return { requested: selection.executable, method: "explicit-path", resolvedPath: resolved };
		}
		return {
			requested: selection.executable,
			method: "explicit-path",
			resolvedPath: null,
			reason: "the explicit path is not an executable file",
		};
	}
	const command = selection.command ?? "codex";
	if (command.length === 0 || /[\\/]/.test(command)) {
		throw new CodexFingerprintErrorV0(
			"the Codex command name must be a bare name; pass a path as the explicit executable",
		);
	}
	const searchPath = selection.path ?? process.env.PATH ?? "";
	for (const directory of searchPath.split(delimiter)) {
		if (directory.length === 0 || !isAbsolute(directory)) continue;
		const candidate = join(directory, command);
		if (await isExecutableFile(candidate)) {
			return { requested: command, method: "path-search", resolvedPath: candidate };
		}
	}
	return { requested: command, method: "path-search", resolvedPath: null, reason: `${command} was not found on PATH` };
}

async function sha256File(path: string, maxBytes: number): Promise<{ sha256: string; bytes: number } | string> {
	const info = await stat(path);
	if (info.size > maxBytes) return `the entrypoint is ${info.size} bytes, over the ${maxBytes}-byte hashing bound`;
	const hash = createHash("sha256");
	let bytes = 0;
	await new Promise<void>((done, fail) => {
		createReadStream(path)
			.on("data", (chunk) => {
				bytes += chunk.length;
				hash.update(chunk);
			})
			.on("error", fail)
			.on("end", () => done());
	});
	return { sha256: hash.digest("hex"), bytes };
}

async function nearestCodexManifest(start: string): Promise<{ name: string; version: string; root: string } | string> {
	let directory = dirname(start);
	for (let depth = 0; depth < 6; depth += 1) {
		const codexManifest = join(directory, "codex-package.json");
		try {
			const parsed: unknown = JSON.parse(await readFile(codexManifest, "utf8"));
			if (typeof parsed === "object" && parsed !== null) {
				const rec = parsed as { version?: unknown; target?: unknown };
				if (typeof rec.version === "string" && rec.version.length > 0) {
					const name =
						typeof rec.target === "string" && rec.target.length > 0
							? `openai-codex:${rec.target}`
							: "openai-codex";
					return { name: name.slice(0, 256), version: rec.version.slice(0, 256), root: directory };
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return `the Codex layout manifest ${codexManifest} is unreadable`;
			}
		}
		const npmManifest = join(directory, "package.json");
		try {
			const parsed: unknown = JSON.parse(await readFile(npmManifest, "utf8"));
			if (typeof parsed === "object" && parsed !== null) {
				const { name, version } = parsed as { name?: unknown; version?: unknown };
				if (typeof name === "string" && name.length > 0 && typeof version === "string" && version.length > 0) {
					return { name: name.slice(0, 256), version: version.slice(0, 256), root: directory };
				}
			}
			return `the nearest package.json (${npmManifest}) declares no name and version`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return `the package manifest ${npmManifest} is unreadable`;
			}
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return "no codex-package.json or package.json manifest was found above the entrypoint";
}

function runVersion(
	executable: string,
	env: Readonly<Record<string, string>>,
	timeoutMs: number,
): Promise<{ output: string } | { failure: string }> {
	return new Promise((done) => {
		execFile(
			executable,
			["--version"],
			{ env: { ...env }, timeout: timeoutMs, maxBuffer: MAX_VERSION_OUTPUT_BYTES, windowsHide: true, shell: false },
			(error, stdout) => {
				if (error !== null) {
					const code = (error as NodeJS.ErrnoException).code;
					done({
						failure:
							error.killed === true
								? `--version did not finish within ${timeoutMs} ms`
								: code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
									? "--version printed more than the output bound"
									: `--version failed (${typeof code === "string" ? code : `exit ${String(code)}`})`,
					});
					return;
				}
				done({ output: String(stdout) });
			},
		);
	});
}

export function codexIdentityEnvironmentV0(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
	};
}

/**
 * Collect one honest `endo.harness-fingerprint.v1` for the selected Codex executable.
 * Standalone compiled Codex executables record `runtimeContent: null` (with an explicit gap) and therefore
 * honestly hold `identity.confidence: "reduced"`: evidence collected against this observation applies ONLY to this
 * exact observation (`fingerprintId`), never silently carried across observations.
 */
export async function fingerprintCodexRuntimeV0(options: CodexFingerprintOptionsV0): Promise<EndoHarnessFingerprintV1> {
	const now = options.now ?? (() => new Date());
	const methods: EndoHarnessFingerprintMethodV1[] = [];
	const gaps: { fact: EndoHarnessFingerprintFactV1; reason: string }[] = [];

	const resolution = await resolveCodexExecutableV0(options);
	methods.push(resolution.method);
	if (resolution.resolvedPath === null) {
		throw new CodexFingerprintErrorV0(
			`the Codex executable could not be resolved: ${resolution.reason ?? "unknown reason"}`,
		);
	}

	let realPath: string | null = null;
	try {
		realPath = await realpath(resolution.resolvedPath);
		methods.push("realpath");
	} catch {
		gaps.push({ fact: "realPath", reason: "the resolved path could not be followed to a real path" });
	}

	let entrypoint: { sha256: string; bytes: number } | null = null;
	let pkg: { name: string; version: string; root: string } | null = null;

	if (realPath !== null) {
		try {
			const hashed = await sha256File(realPath, options.maxEntrypointBytes ?? 512 * 1024 * 1024);
			if (typeof hashed === "string") gaps.push({ fact: "entrypoint", reason: hashed });
			else {
				entrypoint = hashed;
				methods.push("entrypoint-sha256");
			}
		} catch {
			gaps.push({ fact: "entrypoint", reason: "the entrypoint could not be read" });
		}
		const found = await nearestCodexManifest(realPath);
		if (typeof found === "string") gaps.push({ fact: "package", reason: found });
		else {
			pkg = found;
			methods.push("package-manifest");
		}
		// Standalone native Codex executables do not have a package-scoped JS runtime-content tree.
		// Record the gap explicitly so confidence stays honestly "reduced".
		gaps.push({
			fact: "runtimeContent",
			reason:
				"standalone Codex native executable layout does not expose a package-scoped runtime-content tree; entrypoint digest covers the binary only",
		});
	} else {
		gaps.push({ fact: "entrypoint", reason: "no real path to hash" });
		gaps.push({ fact: "package", reason: "no real path to search from" });
		gaps.push({ fact: "runtimeContent", reason: "no real path to scope runtime content from" });
	}

	const observedAt = now().toISOString();
	const outcome = await runVersion(
		resolution.resolvedPath,
		options.env ?? codexIdentityEnvironmentV0(),
		options.versionTimeoutMs ?? 15_000,
	);
	methods.push("version-command");

	let versionText: string | null = null;
	let version: string | null = null;
	if ("failure" in outcome) {
		gaps.push({ fact: "version", reason: outcome.failure });
	} else {
		const trimmed = outcome.output.trim();
		versionText = trimmed.length === 0 ? null : trimmed.slice(0, 1024);
		version = versionText === null ? null : parseCodexVersionOutputV0(versionText);
		if (version === null) {
			gaps.push({
				fact: "version",
				reason: versionText === null ? "--version printed nothing" : "--version output is not a semver version",
			});
		}
	}

	const local: EndoHarnessFingerprintV1["local"] = {
		requested: resolution.requested,
		resolvedPath: resolution.resolvedPath,
		realPath,
		entrypoint,
		package: pkg,
		runtimeContent: null,
	};
	const reported = { versionText, version };
	if (realPath === null && version === null) {
		throw new CodexFingerprintErrorV0("neither a real path nor a reported version identifies the Codex runtime");
	}
	const identity = {
		basis: "runtime-content.v1" as const,
		digest: sha256HexV0(canonicalEndoJsonV0(endoHarnessIdentityBasisV1({ runtime: "codex", local, reported }))),
		confidence: endoHarnessIdentityConfidenceV1({ local, reported }),
	};
	const body = {
		schemaVersion: "endo.harness-fingerprint.v1" as const,
		attachment: options.attachment,
		runtime: "codex",
		observedAt,
		methods,
		local,
		reported,
		gaps,
		identity,
	};
	const fingerprint = { ...body, id: `endo.evidence.codex-fingerprint.${sha256HexV0(canonicalEndoJsonV0(body))}` };
	const validated = validateEndoHarnessFingerprintV1(fingerprint);
	if (validated === null) {
		throw new CodexFingerprintErrorV0("the collected Codex fingerprint failed protocol validation");
	}
	return validated;
}

/** Deterministic SHA-256 over the effective Codex policy & configuration subset a check depends on. */
export function codexConfigurationDigestV0(effective: {
	readonly approvalPolicy: unknown;
	readonly approvalsReviewer: unknown;
	readonly sandbox: unknown;
	readonly model?: string | null;
	readonly modelProvider?: string | null;
	readonly disabledMcpServers?: readonly string[];
	readonly configOverrides?: readonly string[];
}): string {
	return sha256HexV0(
		canonicalEndoJsonV0({
			approvalPolicy: effective.approvalPolicy ?? null,
			approvalsReviewer: effective.approvalsReviewer ?? null,
			sandbox: effective.sandbox ?? null,
			model: effective.model ?? null,
			modelProvider: effective.modelProvider ?? null,
			disabledMcpServers: [...(effective.disabledMcpServers ?? [])].sort(),
			configOverrides: [...(effective.configOverrides ?? [])].sort(),
		} as never),
	);
}
