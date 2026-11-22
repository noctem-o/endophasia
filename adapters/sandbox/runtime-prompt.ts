// Governed runtime capability disclosure for protected Pi runs (PI-RUNTIME-CONSISTENCY-001).
//
// Derives an initial Pi system prompt strictly from the controller's enforced sandbox runtime specification
// (`spec.runtime.executables` and `spec.runtime.aliases`) and registered Pi tool set, without reading any
// agent-controlled workspace file, calling a model, or revealing hidden evaluator or host details.
//
// Scope of claim (explicit):
// - Establishes that the INITIAL system prompt's advertised shell executables, aliases, and Pi tools match the
//   enforced sandbox runtime configuration.
// - Does NOT claim session-wide instruction consistency: Pi's own tool implementations can emit dynamic runtime
//   suggestions during execution (for example, Pi 1.6.0's `read` tool suggests `sed -n '<N>p' <path> | head -c 50KB`
//   when encountering a single line longer than 50 KB, even when `sed` is absent from `PI_RUNTIME_V1`).
// - Does NOT establish new host isolation or alter sandbox permissions; isolation remains enforced by Bubblewrap,
//   systemd scopes, and the host model relay.

import { basename, dirname } from "node:path";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

export const ENDO_PI_RUNTIME_PROMPT_PIN_V0 = "endo.pi-runtime-prompt.v0";

export const ENDO_PI_SUPPORTED_TOOLS_V0 = ["read", "bash", "edit", "write"] as const;
export type EndoPiToolV0 = (typeof ENDO_PI_SUPPORTED_TOOLS_V0)[number];
export const DEFAULT_ENDO_PI_TOOLS_V0: readonly EndoPiToolV0[] = ENDO_PI_SUPPORTED_TOOLS_V0;

export interface EndoSandboxRuntimeSpecV0 {
	executables: readonly string[];
	aliases?: readonly { target: string; executable: string }[];
}

export const ENDO_RUNTIME_PROMPT_REFUSAL_REASONS_V0 = [
	"empty-runtime",
	"invalid-executable-path",
	"executable-outside-path",
	"duplicate-command",
	"invalid-alias",
	"dangling-alias",
	"empty-tools",
	"unknown-tool",
	"duplicate-tool",
	"missing-node-runtime",
	"missing-bash-shell",
	"invalid-cwd",
] as const;
export type EndoRuntimePromptRefusalReasonV0 = (typeof ENDO_RUNTIME_PROMPT_REFUSAL_REASONS_V0)[number];

/** Raised when an opt-in capability-consistent prompt cannot be derived or verified against the enforced runtime. */
export class EndoRuntimePromptErrorV0 extends TypeError {
	readonly reason: string;
	constructor(reason: string, detail: string) {
		super(`runtime capability prompt refused (${reason}): ${detail}`);
		this.name = "EndoRuntimePromptErrorV0";
		this.reason = reason;
	}
}

export interface EndoRuntimeCapabilityPromptV0 {
	/** Text written to `/agent/system-prompt.txt` and passed to Pi via `--system-prompt`. */
	systemPromptBody: string;
	/** SHA-256 of `systemPromptBody` (UTF-8). */
	systemPromptBodySha256: string;
	/** Exact effective `messages[0].content` Pi 1.6.0 emits for `cwd` (`systemPromptBody` + `\n\n<cwd>\n${cwd}\n</cwd>`). */
	expectedEffectiveSystemPrompt: string;
	/** SHA-256 of `expectedEffectiveSystemPrompt` (UTF-8). */
	expectedEffectiveSystemPromptSha256: string;
	/** Canonical SHA-256 over the normalized enforced runtime specification (`executables` + `aliases`). */
	runtimeSha256: string;
	/** Sorted unique command basenames derived strictly from `runtime.executables`. */
	mountedExecutables: string[];
	/** Sorted unique alias mappings derived strictly from `runtime.aliases`. */
	mountedAliases: { alias: string; targetExecutable: string }[];
	/** Common Unix commands absent from `mountedExecutables` + `mountedAliases`. */
	absentCommonCommands: string[];
	/** Registered Pi tools included in `<tools>`, in canonical order as declared. */
	registeredPiTools: EndoPiToolV0[];
	/** Sandbox working directory embedded in `<cwd>`. */
	cwd: string;
}

export interface EndoPiRuntimePromptPinV0 {
	schemaVersion: typeof ENDO_PI_RUNTIME_PROMPT_PIN_V0;
	runtimeSha256: string;
	piTools: EndoPiToolV0[];
	cwd: string;
	mountedExecutables: string[];
	mountedAliases: { alias: string; targetExecutable: string }[];
	systemPromptBodySha256: string;
	expectedEffectiveSystemPromptSha256: string;
}

export type EndoRuntimePromptBuildResultV0 =
	| { ok: true; prompt: EndoRuntimeCapabilityPromptV0; pin: EndoPiRuntimePromptPinV0 }
	| { ok: false; reason: EndoRuntimePromptRefusalReasonV0; detail: string };

/** Common Unix utilities checked against the enforced runtime inventory so absent ones are never advertised. */
const COMMON_UNIX_COMMANDS = [
	"awk",
	"cat",
	"cp",
	"find",
	"git",
	"grep",
	"head",
	"ls",
	"mkdir",
	"mv",
	"python3",
	"rg",
	"rm",
	"sed",
	"sort",
	"tail",
	"tsc",
	"wc",
	"which",
] as const;

const SANDBOX_PATH_DIR = "/usr/bin";
const SAFE_ABS_PATH = /^\/[A-Za-z0-9._+/~-]{1,240}$/;
const SAFE_CMD_NAME = /^[A-Za-z0-9._+-]{1,64}$/;
const SAFE_CWD = /^\/[A-Za-z0-9._/@+-]{0,200}$/;
const SUPPORTED_POSIX_SHELLS = new Set(["sh", "bash", "dash", "ash", "zsh", "ksh", "mksh"]);
const EXTENDED_SHELLS = new Set(["bash", "zsh", "ksh", "mksh"]);

function isSafeAbsPath(p: string): boolean {
	return SAFE_ABS_PATH.test(p) && !p.includes("//") && !p.split("/").includes("..") && !p.split("/").includes(".");
}

/** Canonical digest of an enforced sandbox runtime specification (order-independent). */
export function endoSandboxRuntimeDigestV0(runtime: EndoSandboxRuntimeSpecV0): string {
	const executables = [...runtime.executables].sort();
	const aliases = [...(runtime.aliases ?? [])]
		.map((a) => ({ target: a.target, executable: a.executable }))
		.sort((a, b) =>
			a.target < b.target
				? -1
				: a.target > b.target
					? 1
					: a.executable < b.executable
						? -1
						: a.executable > b.executable
							? 1
							: 0,
		);
	return sha256HexV0(canonicalEndoJsonV0({ executables, aliases }));
}

/**
 * Derive a deterministic, capability-consistent initial system prompt for Pi strictly from the controller's
 * enforced sandbox runtime specification and declared Pi tool set. Refuses rather than inventing capabilities
 * if the runtime specification is empty, malformed, outside `/usr/bin`, or unable to support the selected tools.
 */
export function buildRuntimeCapabilityPromptV0(input: {
	runtime: EndoSandboxRuntimeSpecV0;
	piTools?: readonly string[];
	cwd?: string;
	requireNode?: boolean;
}): EndoRuntimePromptBuildResultV0 {
	const refuse = (reason: EndoRuntimePromptRefusalReasonV0, detail: string): EndoRuntimePromptBuildResultV0 => ({
		ok: false,
		reason,
		detail,
	});

	const cwd = input.cwd ?? "/work";
	if (
		typeof cwd !== "string" ||
		cwd.length === 0 ||
		!SAFE_CWD.test(cwd) ||
		cwd.includes("//") ||
		cwd.split("/").includes("..") ||
		cwd.split("/").includes(".") ||
		(cwd !== "/" && cwd.endsWith("/"))
	) {
		return refuse("invalid-cwd", `cwd must be a plain normalized POSIX absolute path (got ${JSON.stringify(cwd)})`);
	}

	const rawTools = input.piTools ?? DEFAULT_ENDO_PI_TOOLS_V0;
	if (!Array.isArray(rawTools) || rawTools.length === 0) {
		return refuse("empty-tools", "at least one registered Pi tool must be declared");
	}
	const registeredPiTools: EndoPiToolV0[] = [];
	const seenTools = new Set<string>();
	for (const t of rawTools) {
		if (typeof t !== "string" || !(ENDO_PI_SUPPORTED_TOOLS_V0 as readonly string[]).includes(t)) {
			return refuse("unknown-tool", `unsupported Pi tool ${JSON.stringify(t)}`);
		}
		if (seenTools.has(t)) {
			return refuse("duplicate-tool", `duplicate Pi tool ${JSON.stringify(t)}`);
		}
		seenTools.add(t);
		registeredPiTools.push(t as EndoPiToolV0);
	}

	const rawExecutables = input.runtime?.executables;
	if (!Array.isArray(rawExecutables) || rawExecutables.length === 0) {
		return refuse("empty-runtime", "runtime.executables must name at least one mounted executable");
	}
	const executableSet = new Set<string>();
	const seenCommandNames = new Set<string>();
	const mountedExecutables: string[] = [];

	for (const exe of rawExecutables) {
		if (typeof exe !== "string" || !isSafeAbsPath(exe)) {
			return refuse("invalid-executable-path", `invalid executable path ${JSON.stringify(exe)}`);
		}
		if (dirname(exe) !== SANDBOX_PATH_DIR) {
			return refuse(
				"executable-outside-path",
				`executable ${exe} is outside sandbox PATH directory ${SANDBOX_PATH_DIR}`,
			);
		}
		const name = basename(exe);
		if (!SAFE_CMD_NAME.test(name)) {
			return refuse("invalid-executable-path", `invalid executable basename ${JSON.stringify(name)}`);
		}
		if (executableSet.has(exe) || seenCommandNames.has(name)) {
			return refuse("duplicate-command", `duplicate runtime executable ${exe}`);
		}
		executableSet.add(exe);
		seenCommandNames.add(name);
		mountedExecutables.push(name);
	}
	mountedExecutables.sort();

	const rawAliases = input.runtime.aliases ?? [];
	if (!Array.isArray(rawAliases)) {
		return refuse("invalid-alias", "runtime.aliases must be an array");
	}
	const mountedAliases: { alias: string; targetExecutable: string }[] = [];
	for (const entry of rawAliases) {
		if (
			entry === null ||
			typeof entry !== "object" ||
			typeof entry.target !== "string" ||
			typeof entry.executable !== "string" ||
			!isSafeAbsPath(entry.target) ||
			!isSafeAbsPath(entry.executable)
		) {
			return refuse("invalid-alias", "every runtime alias must specify valid absolute target and executable paths");
		}
		if (dirname(entry.target) !== SANDBOX_PATH_DIR) {
			return refuse(
				"executable-outside-path",
				`alias target ${entry.target} is outside sandbox PATH directory ${SANDBOX_PATH_DIR}`,
			);
		}
		if (!executableSet.has(entry.executable)) {
			return refuse("dangling-alias", `alias ${entry.target} points to undeclared executable ${entry.executable}`);
		}
		const aliasName = basename(entry.target);
		if (!SAFE_CMD_NAME.test(aliasName)) {
			return refuse("invalid-alias", `invalid alias basename ${JSON.stringify(aliasName)}`);
		}
		if (seenCommandNames.has(aliasName)) {
			return refuse("duplicate-command", `alias ${entry.target} collides with another mounted command`);
		}
		seenCommandNames.add(aliasName);
		mountedAliases.push({ alias: aliasName, targetExecutable: basename(entry.executable) });
	}
	mountedAliases.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));

	const resolvedTarget = new Map<string, string>();
	for (const name of mountedExecutables) resolvedTarget.set(name, name);
	for (const a of mountedAliases) resolvedTarget.set(a.alias, a.targetExecutable);

	const requireNode = input.requireNode ?? true;
	if (requireNode && resolvedTarget.get("node") !== "node") {
		return refuse("missing-node-runtime", "Pi requires /usr/bin/node in runtime.executables");
	}

	const hasCmd = (name: string) => seenCommandNames.has(name);
	const hasExecutableCmd = (name: string) => resolvedTarget.get(name) === name;
	const hasTool = (name: EndoPiToolV0) => seenTools.has(name);

	// Pi 1.6.0's getShellConfig() tries /bin/bash (absent in empty root), then `which bash`, then falls back to `sh -c`.
	// When `bash` tool is registered, require a runnable shell executable (resolving aliases to their underlying binary).
	const canInvokeBashViaWhich = hasExecutableCmd("which") && resolvedTarget.get("bash") === "bash";
	const shTarget = resolvedTarget.get("sh");
	const canInvokeShFallback = shTarget !== undefined && SUPPORTED_POSIX_SHELLS.has(shTarget);
	if (hasTool("bash") && !canInvokeBashViaWhich && !canInvokeShFallback) {
		return refuse(
			"missing-bash-shell",
			"Pi bash tool requires a runnable POSIX shell at /usr/bin/sh (e.g. alias to /usr/bin/bash) when /bin/bash and which+bash are absent",
		);
	}

	const absentCommonCommands = COMMON_UNIX_COMMANDS.filter((c) => !hasCmd(c));
	const aliasSummary =
		mountedAliases.length > 0
			? `; aliases: ${mountedAliases.map((a) => `${a.alias} -> ${a.targetExecutable}`).join(", ")}`
			: "";

	const toolLines: string[] = [];
	for (const tool of registeredPiTools) {
		if (tool === "read") {
			toolLines.push("- read: Read file contents (supports offset and limit for line slices)");
		} else if (tool === "bash") {
			toolLines.push(
				`- bash: Execute shell commands using only mounted executables (${mountedExecutables.join(", ")}${aliasSummary})`,
			);
		} else if (tool === "edit") {
			toolLines.push(
				"- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
			);
		} else if (tool === "write") {
			toolLines.push("- write: Create or overwrite files (automatically creates parent directories)");
		}
	}

	const runtimeLines: string[] = [
		`- Registered Pi tools (complete list): ${registeredPiTools.join(", ")}.`,
		`- Mounted /usr/bin executables (complete list): ${mountedExecutables.join(", ")}.`,
	];
	if (mountedAliases.length > 0) {
		runtimeLines.push(
			`- Mounted /usr/bin aliases: ${mountedAliases.map((a) => `${a.alias} -> ${a.targetExecutable}`).join(", ")}.`,
		);
	}
	if (hasTool("bash")) {
		const shAlias = mountedAliases.find((a) => a.alias === "sh");
		if (shAlias && !canInvokeBashViaWhich) {
			if (EXTENDED_SHELLS.has(shAlias.targetExecutable)) {
				runtimeLines.push(
					`- Shell execution: the bash tool runs \`sh -c\` via /usr/bin/sh (-> ${shAlias.targetExecutable}) with shell builtins available; invoke \`${shAlias.targetExecutable} -c\` explicitly if non-POSIX features are needed.`,
				);
			} else {
				runtimeLines.push(
					`- Shell execution: the bash tool runs \`sh -c\` via /usr/bin/sh (-> ${shAlias.targetExecutable}) with POSIX shell builtins available.`,
				);
			}
		}
		runtimeLines.push(
			"- Only the executables listed above are present on PATH (/usr/bin); any external command outside this list will fail with exit code 127.",
		);
		if (absentCommonCommands.length > 0) {
			runtimeLines.push(`- Commonly expected utilities NOT installed: ${absentCommonCommands.join(", ")}.`);
		}
	}

	const rules: string[] = [];
	if (hasTool("bash")) {
		const ops: string[] = [];
		if (hasExecutableCmd("ls")) ops.push("`ls -R` to list directory trees");
		if (hasExecutableCmd("grep")) ops.push("`grep -rn` to search file contents");
		if (hasExecutableCmd("node")) ops.push("`node` to run JavaScript/TypeScript scripts directly");
		if (ops.length > 0) rules.push(`Within bash, use only mounted commands: ${ops.join("; ")}.`);
	}
	if (hasTool("read")) {
		rules.push(
			"Use read (with offset and limit for slices or file tails) to examine files instead of shell pipelines.",
		);
	}
	if (hasTool("bash")) {
		rules.push("You can inspect PI_* environment variables for current model and session details.");
	}
	if (hasTool("edit")) {
		rules.push("Use edit for targeted changes. Batch changes to one file in a single call.");
		rules.push(
			"Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
		);
	}
	if (hasTool("write")) {
		rules.push("Use write only for new files or complete rewrites; write creates parent directories automatically.");
	}
	rules.push("Be concise in your responses");
	rules.push("Show file paths clearly when working with files");

	const systemPromptBody = [
		"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
		"",
		"<tools>",
		...toolLines,
		"</tools>",
		"",
		"<sandbox_runtime>",
		...runtimeLines,
		"</sandbox_runtime>",
		"",
		"<rules>",
		...rules.map((r) => `- ${r}`),
		"</rules>",
	].join("\n");

	const expectedEffectiveSystemPrompt = `${systemPromptBody}\n\n<cwd>\n${cwd}\n</cwd>`;
	const systemPromptBodySha256 = sha256HexV0(systemPromptBody);
	const expectedEffectiveSystemPromptSha256 = sha256HexV0(expectedEffectiveSystemPrompt);
	const runtimeSha256 = endoSandboxRuntimeDigestV0(input.runtime);

	const prompt: EndoRuntimeCapabilityPromptV0 = {
		systemPromptBody,
		systemPromptBodySha256,
		expectedEffectiveSystemPrompt,
		expectedEffectiveSystemPromptSha256,
		runtimeSha256,
		mountedExecutables,
		mountedAliases,
		absentCommonCommands,
		registeredPiTools,
		cwd,
	};
	const pin: EndoPiRuntimePromptPinV0 = {
		schemaVersion: ENDO_PI_RUNTIME_PROMPT_PIN_V0,
		runtimeSha256,
		piTools: [...registeredPiTools],
		cwd,
		mountedExecutables: [...mountedExecutables],
		mountedAliases: mountedAliases.map((a) => ({ ...a })),
		systemPromptBodySha256,
		expectedEffectiveSystemPromptSha256,
	};
	return { ok: true, prompt, pin };
}

/**
 * Verify that a stored pin manifest and system-prompt file bytes match the prompt derived from the enforced
 * runtime specification and declared Pi tool set. Fails closed on any mismatch.
 */
export function verifyRuntimeCapabilityPromptPinV0(input: {
	runtime: EndoSandboxRuntimeSpecV0;
	piTools?: readonly string[];
	cwd?: string;
	requireNode?: boolean;
	pin: unknown;
	systemPromptBody: string;
}):
	| { ok: true; prompt: EndoRuntimeCapabilityPromptV0; pin: EndoPiRuntimePromptPinV0 }
	| { ok: false; reason: string; detail: string } {
	const built = buildRuntimeCapabilityPromptV0(input);
	if (!built.ok) return built;
	if (input.pin === null || typeof input.pin !== "object" || Array.isArray(input.pin)) {
		return { ok: false, reason: "invalid-pin", detail: "runtime-prompt.json is not a plain object" };
	}
	const p = input.pin as Record<string, unknown>;
	if (p.runtimeSha256 !== built.pin.runtimeSha256) {
		return {
			ok: false,
			reason: "runtime-pin-mismatch",
			detail: `pinned runtime digest ${String(p.runtimeSha256)} does not match enforced runtime ${built.pin.runtimeSha256}`,
		};
	}
	if (typeof input.systemPromptBody !== "string") {
		return { ok: false, reason: "prompt-mismatch", detail: "system prompt body is not text" };
	}
	const actualBodySha = sha256HexV0(input.systemPromptBody);
	if (
		actualBodySha !== built.prompt.systemPromptBodySha256 ||
		input.systemPromptBody !== built.prompt.systemPromptBody
	) {
		return {
			ok: false,
			reason: "prompt-mismatch",
			detail: `system-prompt.txt digest ${actualBodySha} does not match enforced runtime prompt ${built.prompt.systemPromptBodySha256}`,
		};
	}
	const actualPinCanonical = (() => {
		try {
			return canonicalEndoJsonV0(input.pin);
		} catch {
			return null;
		}
	})();
	const expectedPinCanonical = canonicalEndoJsonV0(built.pin);
	if (actualPinCanonical !== expectedPinCanonical) {
		return {
			ok: false,
			reason: "pin-mismatch",
			detail: "runtime-prompt.json does not match the prompt derived from the enforced runtime",
		};
	}
	return built;
}
