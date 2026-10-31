// Pi runtime identity: which installed Pi an attachment would run, observed without changing it.
//
// Resolution never installs, updates or rebuilds anything. It finds the executable the operator selected (an explicit
// path, or `pi` on PATH), follows symlinks, hashes the file the symlinks end at, reads the nearest package manifest,
// and runs `<executable> --version` once, directly (never through a shell), with a bounded timeout and output.
//
// Scope of the fingerprint, stated plainly. Two digests, kept apart:
//  - the entrypoint digest covers one file. For an npm install of Pi that file is `dist/bundle/cli.js`, a ~160-byte
//    launcher that is byte-identical across releases;
//  - the runtime-content digest (runtime-content.ts) covers every file in the directory the entrypoint sits in
//    (`dist/bundle`), where the program actually is. It is what lets a same-version change to the code be seen.
// Neither covers the Node binary, packages imported from node_modules, user configuration or extensions. The package
// manifest names the package the entrypoint sits in, as the manifest says; it is a local fact, not a verified
// provenance, and hashing local files does not authenticate a publisher. The version is what Pi reported.
//
// New fingerprints are endo.harness-fingerprint.v1 (identity basis runtime-content.v1). When the layout has no
// supported scope, or its files cannot all be read, the fingerprint records a `runtimeContent` gap and a reduced
// identity instead of a partial digest. v0 fingerprints already in a registry are never rewritten.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
	type EndoHarnessFingerprintFactV1,
	type EndoHarnessFingerprintMethodV1,
	type EndoHarnessFingerprintV1,
	type EndoHarnessRuntimeContentV1,
	endoHarnessIdentityBasisV1,
	endoHarnessIdentityConfidenceV1,
	validateEndoHarnessFingerprintV1,
} from "../../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { hashPiRuntimeContentV1, type PiRuntimeContentLimitsV1 } from "./runtime-content.ts";
import { parsePiVersionOutputV0 } from "./version.ts";

/** How the operator selected the executable. */
export interface PiExecutableSelectionV0 {
	/** An explicit executable path (absolute, or relative to cwd). Wins over the PATH search when set. */
	readonly executable?: string;
	/** The command searched on PATH when no explicit path is given. Default "pi". */
	readonly command?: string;
	/** The PATH to search. Default: process.env.PATH. */
	readonly path?: string;
	/** Where a relative explicit path resolves. Default: process.cwd(). */
	readonly cwd?: string;
}

export interface PiFingerprintOptionsV0 extends PiExecutableSelectionV0 {
	/** The configured attachment identity, e.g. `pi.default`. */
	readonly attachment: string;
	/** The environment `--version` runs with. Default: PATH and HOME from this process, plus Pi's offline switches. */
	readonly env?: Readonly<Record<string, string>>;
	/** Bound on `--version`. Default 15 s. */
	readonly versionTimeoutMs?: number;
	/** Largest entrypoint hashed. Default 512 MiB; a larger file is recorded as a gap, not partially hashed. */
	readonly maxEntrypointBytes?: number;
	/** The observation clock. Default: the system clock. */
	readonly now?: () => Date;
	/** Bounds on the runtime-content walk (defaults in runtime-content.ts), and a test seam between hashing and re-listing. */
	readonly runtimeContent?: {
		readonly limits?: Partial<PiRuntimeContentLimitsV1>;
		readonly afterHashing?: () => Promise<void>;
	};
}

/** Thrown when no fingerprint can be taken: nothing identifies the runtime. */
export class PiFingerprintErrorV0 extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiFingerprintErrorV0";
	}
}

const MAX_VERSION_OUTPUT_BYTES = 4096;

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

/**
 * Resolve the selected executable to a path, without running it. Returns the requested string and the resolved path,
 * or null with a reason. PATH entries are searched in order; an empty entry is skipped (never "the current
 * directory").
 */
export async function resolvePiExecutableV0(selection: PiExecutableSelectionV0): Promise<{
	requested: string;
	method: "explicit-path" | "path-search";
	resolvedPath: string | null;
	reason?: string;
}> {
	const cwd = selection.cwd ?? process.cwd();
	if (selection.executable !== undefined) {
		if (selection.executable.length === 0) throw new PiFingerprintErrorV0("the explicit Pi executable path is empty");
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
	const command = selection.command ?? "pi";
	if (command.length === 0 || /[\\/]/.test(command)) {
		throw new PiFingerprintErrorV0("the Pi command name must be a bare name; pass a path as the explicit executable");
	}
	const searchPath = selection.path ?? process.env.PATH ?? "";
	for (const directory of searchPath.split(delimiter)) {
		if (directory.length === 0 || !isAbsolute(directory)) continue;
		const candidate = join(directory, command);
		if (await isExecutableFile(candidate))
			return { requested: command, method: "path-search", resolvedPath: candidate };
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

async function nearestPackage(start: string): Promise<{ name: string; version: string; root: string } | string> {
	let directory = dirname(start);
	for (let depth = 0; depth < 12; depth += 1) {
		const manifest = join(directory, "package.json");
		try {
			const parsed: unknown = JSON.parse(await readFile(manifest, "utf8"));
			if (typeof parsed === "object" && parsed !== null) {
				const { name, version } = parsed as { name?: unknown; version?: unknown };
				if (typeof name === "string" && name.length > 0 && typeof version === "string" && version.length > 0) {
					return { name: name.slice(0, 256), version: version.slice(0, 256), root: directory };
				}
			}
			return `the nearest package.json (${manifest}) declares no name and version`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				return `the package manifest ${manifest} is unreadable`;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return "no package.json was found above the entrypoint";
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

/** The default environment for `--version`: enough to start, and Pi's documented switches against network activity. */
export function piIdentityEnvironmentV0(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	};
}

/**
 * Take one fingerprint of the selected Pi. Every fact that cannot be collected is recorded as a gap with its reason.
 * Throws PiFingerprintErrorV0 when nothing identifies the runtime (no executable resolved, or neither a real path nor
 * a reported version): the caller records a collection failure instead of a fingerprint.
 */
export async function fingerprintPiRuntimeV0(options: PiFingerprintOptionsV0): Promise<EndoHarnessFingerprintV1> {
	const now = options.now ?? (() => new Date());
	const methods: EndoHarnessFingerprintMethodV1[] = [];
	const gaps: { fact: EndoHarnessFingerprintFactV1; reason: string }[] = [];
	const resolution = await resolvePiExecutableV0(options);
	methods.push(resolution.method);
	if (resolution.resolvedPath === null) {
		throw new PiFingerprintErrorV0(
			`the Pi executable could not be resolved: ${resolution.reason ?? "unknown reason"}`,
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
	let runtimeContent: EndoHarnessRuntimeContentV1 | null = null;
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
		const found = await nearestPackage(realPath);
		if (typeof found === "string") gaps.push({ fact: "package", reason: found });
		else {
			pkg = found;
			methods.push("package-manifest");
		}
		if (pkg === null) gaps.push({ fact: "runtimeContent", reason: "no package to scope the runtime content to" });
		else if (entrypoint === null)
			gaps.push({ fact: "runtimeContent", reason: "the entrypoint was not hashed, so the runtime content is not" });
		else {
			const covered = await hashPiRuntimeContentV1({
				entrypoint: realPath,
				packageRoot: pkg.root,
				...(options.runtimeContent?.limits === undefined ? {} : { limits: options.runtimeContent.limits }),
				...(options.runtimeContent?.afterHashing === undefined
					? {}
					: { afterHashing: options.runtimeContent.afterHashing }),
			});
			if (covered.ok) {
				runtimeContent = covered.content;
				methods.push("runtime-content-sha256");
			} else gaps.push({ fact: "runtimeContent", reason: covered.reason });
		}
	} else {
		gaps.push({ fact: "entrypoint", reason: "no real path to hash" });
		gaps.push({ fact: "package", reason: "no real path to search from" });
		gaps.push({ fact: "runtimeContent", reason: "no real path to scope the runtime content to" });
	}
	const observedAt = now().toISOString();
	const outcome = await runVersion(
		resolution.resolvedPath,
		options.env ?? piIdentityEnvironmentV0(),
		options.versionTimeoutMs ?? 15_000,
	);
	methods.push("version-command");
	let versionText: string | null = null;
	let version: string | null = null;
	if ("failure" in outcome) gaps.push({ fact: "version", reason: outcome.failure });
	else {
		const trimmed = outcome.output.trim();
		versionText = trimmed.length === 0 ? null : trimmed.slice(0, 1024);
		version = versionText === null ? null : parsePiVersionOutputV0(versionText);
		if (version === null) {
			gaps.push({
				fact: "version",
				reason: versionText === null ? "--version printed nothing" : "--version output is not a semver version",
			});
		}
	}
	const local = {
		requested: resolution.requested,
		resolvedPath: resolution.resolvedPath,
		realPath,
		entrypoint,
		package: pkg,
		runtimeContent,
	};
	const reported = { versionText, version };
	if (realPath === null && version === null) {
		throw new PiFingerprintErrorV0("neither a real path nor a reported version identifies the runtime");
	}
	const identity = {
		basis: "runtime-content.v1" as const,
		digest: sha256HexV0(canonicalEndoJsonV0(endoHarnessIdentityBasisV1({ runtime: "pi", local, reported }))),
		confidence: endoHarnessIdentityConfidenceV1({ local, reported }),
	};
	const body = {
		schemaVersion: "endo.harness-fingerprint.v1" as const,
		attachment: options.attachment,
		runtime: "pi",
		observedAt,
		methods,
		local,
		reported,
		gaps,
		identity,
	};
	const fingerprint = { ...body, id: `endo.evidence.pi-fingerprint.${sha256HexV0(canonicalEndoJsonV0(body))}` };
	const validated = validateEndoHarnessFingerprintV1(fingerprint);
	if (validated === null) throw new PiFingerprintErrorV0("the collected fingerprint failed validation");
	return validated;
}
