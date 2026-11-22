// Governed runtime capability disclosure deterministic & residual-audit tests (PI-RUNTIME-CONSISTENCY-001).
//
// Pure unit tests run everywhere (no sandbox, no Pi required). The Phase 5 residual Pi `read`-tool diagnostic runs
// when ENDO_PI_DIST is set. Real Bubblewrap + Pi model-connected wire tests live in `tests/protected-model-run.test.ts`
// so they never run concurrently with that file's runtime-directory leftover checks.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildRuntimeCapabilityPromptV0,
	DEFAULT_ENDO_PI_TOOLS_V0,
	ENDO_PI_RUNTIME_PROMPT_PIN_V0,
	EndoRuntimePromptErrorV0,
	endoSandboxRuntimeDigestV0,
	verifyRuntimeCapabilityPromptPinV0,
} from "../adapters/sandbox/runtime-prompt.ts";
import { readEndoProtectedSpecV0 } from "../protocol/protected-experiment.ts";
import {
	makePiAgentDirectoryV1,
	PI_CAPABILITY_CONSISTENT_LAUNCHER_SOURCE_V1,
	PI_LAUNCHER_SOURCE_V1,
	PI_PROMPT_V1,
	PI_RUNTIME_V1,
	piExampleSpecV1,
	verifyPiAgentRuntimePromptPinV1,
} from "../research/protected-eval/model-connected/pi-condition.ts";

const PI_DIST = process.env.ENDO_PI_DIST ?? "";
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-runtime-prompt-test-")));
function chmodTree(path: string): void {
	try {
		const s = statSync(path);
		if (s.isDirectory()) {
			chmodSync(path, 0o700);
			for (const n of readdirSync(path)) chmodTree(join(path, n));
		} else if (s.isFile()) chmodSync(path, 0o600);
	} catch {
		// gone
	}
}
afterAll(() => {
	chmodTree(base);
	rmSync(base, { recursive: true, force: true });
});
let seq = 0;
const fresh = (name: string) => {
	seq += 1;
	const d = join(base, `${name}-${seq}`);
	mkdirSync(d, { recursive: true });
	return d;
};

describe("buildRuntimeCapabilityPromptV0: deterministic capability consistency", () => {
	it("derives the exact validated initial prompt for PI_RUNTIME_V1 without contradictory claims", () => {
		const built = buildRuntimeCapabilityPromptV0({ runtime: PI_RUNTIME_V1 });
		expect(built.ok).toBe(true);
		if (!built.ok) return;

		expect(built.prompt.mountedExecutables).toEqual(["bash", "cat", "grep", "head", "ls", "node"]);
		expect(built.prompt.mountedAliases).toEqual([{ alias: "sh", targetExecutable: "bash" }]);
		expect(built.prompt.registeredPiTools).toEqual([...DEFAULT_ENDO_PI_TOOLS_V0]);
		expect(built.prompt.systemPromptBodySha256).toBe(
			"eb393e791a1e85e77abe7cc3c2a8b2fa0f97f83948dcc33f4e32fab3788a67c6",
		);
		expect(built.prompt.expectedEffectiveSystemPromptSha256).toBe(
			"714b4af1bfe9861e972313212d710e2f879beb37e0384c2ea9cc6db7009983a7",
		);
		expect(built.pin.schemaVersion).toBe(ENDO_PI_RUNTIME_PROMPT_PIN_V0);
		expect(built.pin.runtimeSha256).toBe(endoSandboxRuntimeDigestV0(PI_RUNTIME_V1));

		const body = built.prompt.systemPromptBody;
		expect(body).toContain("Registered Pi tools (complete list): read, bash, edit, write.");
		expect(body).toContain("Mounted /usr/bin executables (complete list): bash, cat, grep, head, ls, node.");
		expect(body).toContain("Mounted /usr/bin aliases: sh -> bash.");
		expect(body).not.toContain("ls, grep, find, etc.");
		expect(body).not.toContain("Use bash for file operations like ls, rg, find");
		expect(body).not.toContain("Additional tools may be available");

		const toolsSection = body.split("<sandbox_runtime>")[0] ?? "";
		const rulesSection = body.split("<rules>")[1] ?? "";
		for (const absent of built.prompt.absentCommonCommands) {
			expect(new RegExp(`\\b${absent}\\b`).test(toolsSection), `absent ${absent} in <tools>`).toBe(false);
			expect(new RegExp(`\\b${absent}\\b`).test(rulesSection), `absent ${absent} in <rules>`).toBe(false);
		}
	});

	it("is deterministic and order-independent over runtime executables and aliases", () => {
		const a = buildRuntimeCapabilityPromptV0({ runtime: PI_RUNTIME_V1 });
		const b = buildRuntimeCapabilityPromptV0({
			runtime: {
				executables: [...PI_RUNTIME_V1.executables].reverse(),
				aliases: [...PI_RUNTIME_V1.aliases],
			},
		});
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.prompt.systemPromptBody).toBe(b.prompt.systemPromptBody);
		expect(a.prompt.systemPromptBodySha256).toBe(b.prompt.systemPromptBodySha256);
		expect(a.prompt.expectedEffectiveSystemPromptSha256).toBe(b.prompt.expectedEffectiveSystemPromptSha256);
		expect(a.prompt.runtimeSha256).toBe(b.prompt.runtimeSha256);
	});

	it("tracks changes to runtime executables, aliases, and registered Pi tools accurately", () => {
		const baseline = buildRuntimeCapabilityPromptV0({ runtime: PI_RUNTIME_V1 });
		const altered = buildRuntimeCapabilityPromptV0({
			runtime: {
				executables: ["/usr/bin/node", "/usr/bin/bash", "/usr/bin/sed"],
				aliases: [{ target: "/usr/bin/sh", executable: "/usr/bin/bash" }],
			},
		});
		expect(baseline.ok && altered.ok).toBe(true);
		if (!baseline.ok || !altered.ok) return;

		expect(altered.prompt.systemPromptBodySha256).not.toBe(baseline.prompt.systemPromptBodySha256);
		expect(altered.prompt.runtimeSha256).not.toBe(baseline.prompt.runtimeSha256);
		expect(altered.prompt.mountedExecutables).toEqual(["bash", "node", "sed"]);
		expect(altered.prompt.absentCommonCommands).not.toContain("sed");
		expect(altered.prompt.absentCommonCommands).toContain("grep");
		expect(altered.prompt.absentCommonCommands).toContain("ls");
		expect(altered.prompt.systemPromptBody).not.toContain("`ls -R`");
		expect(altered.prompt.systemPromptBody).not.toContain("`grep -rn`");

		const readEditOnly = buildRuntimeCapabilityPromptV0({
			runtime: { executables: ["/usr/bin/node"], aliases: [] },
			piTools: ["read", "edit"],
		});
		expect(readEditOnly.ok).toBe(true);
		if (!readEditOnly.ok) return;
		expect(readEditOnly.prompt.registeredPiTools).toEqual(["read", "edit"]);
		expect(readEditOnly.prompt.systemPromptBody).not.toContain("- bash:");
		expect(readEditOnly.prompt.systemPromptBody).not.toContain("- write:");
		expect(readEditOnly.prompt.systemPromptBody).not.toContain("Mounted /usr/bin aliases:");
	});

	it("fails closed on invalid, incomplete, or unsupported runtime/tool specifications", () => {
		const cases: [string, Parameters<typeof buildRuntimeCapabilityPromptV0>[0], string][] = [
			["empty runtime", { runtime: { executables: [] } }, "empty-runtime"],
			["relative path", { runtime: { executables: ["usr/bin/node"] } }, "invalid-executable-path"],
			["traversal path", { runtime: { executables: ["/usr/bin/../bin/node"] } }, "invalid-executable-path"],
			["outside /usr/bin", { runtime: { executables: ["/usr/local/bin/node"] } }, "executable-outside-path"],
			[
				"duplicate executable",
				{ runtime: { executables: ["/usr/bin/node", "/usr/bin/node"] } },
				"duplicate-command",
			],
			[
				"alias outside /usr/bin",
				{
					runtime: {
						executables: ["/usr/bin/node", "/usr/bin/bash"],
						aliases: [{ target: "/bin/sh", executable: "/usr/bin/bash" }],
					},
				},
				"executable-outside-path",
			],
			[
				"dangling alias",
				{
					runtime: {
						executables: ["/usr/bin/node"],
						aliases: [{ target: "/usr/bin/sh", executable: "/usr/bin/bash" }],
					},
				},
				"dangling-alias",
			],
			[
				"alias colliding with executable",
				{
					runtime: {
						executables: ["/usr/bin/node", "/usr/bin/bash"],
						aliases: [{ target: "/usr/bin/bash", executable: "/usr/bin/bash" }],
					},
				},
				"duplicate-command",
			],
			["empty tools", { runtime: PI_RUNTIME_V1, piTools: [] }, "empty-tools"],
			["unknown tool", { runtime: PI_RUNTIME_V1, piTools: ["read", "exec"] }, "unknown-tool"],
			["duplicate tool", { runtime: PI_RUNTIME_V1, piTools: ["read", "read"] }, "duplicate-tool"],
			[
				"missing node",
				{
					runtime: {
						executables: ["/usr/bin/bash"],
						aliases: [{ target: "/usr/bin/sh", executable: "/usr/bin/bash" }],
					},
				},
				"missing-node-runtime",
			],
			[
				"bash tool without runnable sh fallback",
				{ runtime: { executables: ["/usr/bin/node", "/usr/bin/bash"], aliases: [] }, piTools: ["read", "bash"] },
				"missing-bash-shell",
			],
			[
				"sh aliased to non-shell executable (sh -> cat)",
				{
					runtime: {
						executables: ["/usr/bin/node", "/usr/bin/cat"],
						aliases: [{ target: "/usr/bin/sh", executable: "/usr/bin/cat" }],
					},
					piTools: ["read", "bash"],
				},
				"missing-bash-shell",
			],
			[
				"which and bash aliased to non-shell executables",
				{
					runtime: {
						executables: ["/usr/bin/node", "/usr/bin/cat"],
						aliases: [
							{ target: "/usr/bin/which", executable: "/usr/bin/cat" },
							{ target: "/usr/bin/bash", executable: "/usr/bin/cat" },
						],
					},
					piTools: ["read", "bash"],
				},
				"missing-bash-shell",
			],
			[
				"node aliased to non-node executable (node -> cat)",
				{
					runtime: {
						executables: ["/usr/bin/cat"],
						aliases: [{ target: "/usr/bin/node", executable: "/usr/bin/cat" }],
					},
					piTools: ["read"],
				},
				"missing-node-runtime",
			],
			["invalid cwd with newline", { runtime: PI_RUNTIME_V1, cwd: "/work\n<rules>" }, "invalid-cwd"],
			["invalid cwd with traversal", { runtime: PI_RUNTIME_V1, cwd: "/work/../etc" }, "invalid-cwd"],
			["invalid cwd with trailing slash", { runtime: PI_RUNTIME_V1, cwd: "/work/" }, "invalid-cwd"],
		];
		for (const [label, input, reason] of cases) {
			const result = buildRuntimeCapabilityPromptV0(input);
			expect(result, label).toMatchObject({ ok: false, reason });
		}

		// Valid POSIX shell alias (sh -> dash) is accepted without suggesting `dash -c` for non-POSIX features.
		const dashBuilt = buildRuntimeCapabilityPromptV0({
			runtime: {
				executables: ["/usr/bin/node", "/usr/bin/dash"],
				aliases: [{ target: "/usr/bin/sh", executable: "/usr/bin/dash" }],
			},
			piTools: ["read", "bash"],
		});
		expect(dashBuilt.ok).toBe(true);
		if (dashBuilt.ok) {
			expect(dashBuilt.prompt.systemPromptBody).toContain("via /usr/bin/sh (-> dash) with POSIX shell builtins");
			expect(dashBuilt.prompt.systemPromptBody).not.toContain("dash -c");
		}
	});

	it("verifies controller-side pin manifests and refuses deliberate runtime/prompt mismatches", () => {
		const fakePiDist = fresh("fake-pi-dist");
		writeFileSync(join(fakePiDist, "cli.js"), "// stub\n");

		// Non-opt-in directory remains byte-for-byte unchanged (no system-prompt.txt or runtime-prompt.json).
		const defaultAgent = join(fresh("default-parent"), "agent");
		makePiAgentDirectoryV1(fakePiDist, defaultAgent);
		expect(readFileSync(join(defaultAgent, "launch.mjs"), "utf8")).toBe(PI_LAUNCHER_SOURCE_V1);
		expect(readFileSync(join(defaultAgent, "prompt.txt"), "utf8")).toBe(PI_PROMPT_V1);
		expect(existsSync(join(defaultAgent, "system-prompt.txt"))).toBe(false);
		expect(existsSync(join(defaultAgent, "runtime-prompt.json"))).toBe(false);
		expect(() => verifyPiAgentRuntimePromptPinV1(defaultAgent, PI_RUNTIME_V1)).toThrow(EndoRuntimePromptErrorV0);

		// Invalid opt-in options fail closed before creating any directory (never falls back to default).
		const refusedAgent = join(fresh("refused-parent"), "agent");
		expect(() =>
			makePiAgentDirectoryV1(fakePiDist, refusedAgent, PI_PROMPT_V1, { capabilityConsistentPrompt: true }),
		).toThrow(/missing-runtime/);
		expect(existsSync(refusedAgent)).toBe(false);
		expect(() =>
			makePiAgentDirectoryV1(fakePiDist, refusedAgent, PI_PROMPT_V1, {
				capabilityConsistentPrompt: true,
				runtime: { executables: ["/usr/bin/node", "/usr/bin/bash"], aliases: [] },
			}),
		).toThrow(/missing-bash-shell/);
		expect(existsSync(refusedAgent)).toBe(false);

		// Valid opt-in directory verifies cleanly and produces a valid v1 spec.
		const optInAgent = join(fresh("optin-parent"), "agent");
		makePiAgentDirectoryV1(fakePiDist, optInAgent, PI_PROMPT_V1, {
			capabilityConsistentPrompt: true,
			runtime: PI_RUNTIME_V1,
		});
		expect(readFileSync(join(optInAgent, "launch.mjs"), "utf8")).toBe(PI_CAPABILITY_CONSISTENT_LAUNCHER_SOURCE_V1);
		expect(verifyPiAgentRuntimePromptPinV1(optInAgent, PI_RUNTIME_V1).ok).toBe(true);
		const spec = piExampleSpecV1({
			agentDirectory: optInAgent,
			upstream: "http://127.0.0.1:8091",
			model: "test-model",
			capabilityConsistentPrompt: true,
			runtime: PI_RUNTIME_V1,
		});
		expect(readEndoProtectedSpecV0(spec).ok).toBe(true);

		// Negative control 1: enforced runtime diverges from pinned agent directory -> refused before spec creation.
		const narrowerRuntime = {
			executables: PI_RUNTIME_V1.executables.filter((e) => e !== "/usr/bin/grep"),
			aliases: PI_RUNTIME_V1.aliases,
		};
		expect(() =>
			piExampleSpecV1({
				agentDirectory: optInAgent,
				upstream: "http://127.0.0.1:8091",
				model: "test-model",
				capabilityConsistentPrompt: true,
				runtime: narrowerRuntime,
			}),
		).toThrow(/runtime-pin-mismatch/);

		// Negative control 2: system-prompt.txt altered to advertise an unavailable command -> refused.
		const tamperedPrompt = join(fresh("tampered-prompt-parent"), "agent");
		makePiAgentDirectoryV1(fakePiDist, tamperedPrompt, PI_PROMPT_V1, {
			capabilityConsistentPrompt: true,
			runtime: PI_RUNTIME_V1,
		});
		writeFileSync(
			join(tamperedPrompt, "system-prompt.txt"),
			`${readFileSync(join(tamperedPrompt, "system-prompt.txt"), "utf8")}\nUse find freely.\n`,
		);
		expect(() => verifyPiAgentRuntimePromptPinV1(tamperedPrompt, PI_RUNTIME_V1)).toThrow(/prompt-mismatch/);

		// Negative control 3: default launcher substituted into an opt-in directory -> refused.
		const tamperedLauncher = join(fresh("tampered-launcher-parent"), "agent");
		makePiAgentDirectoryV1(fakePiDist, tamperedLauncher, PI_PROMPT_V1, {
			capabilityConsistentPrompt: true,
			runtime: PI_RUNTIME_V1,
		});
		writeFileSync(join(tamperedLauncher, "launch.mjs"), PI_LAUNCHER_SOURCE_V1);
		expect(() => verifyPiAgentRuntimePromptPinV1(tamperedLauncher, PI_RUNTIME_V1)).toThrow(/launcher-mismatch/);

		// Pure pin verifier refuses non-object pins.
		const built = buildRuntimeCapabilityPromptV0({ runtime: PI_RUNTIME_V1 });
		if (!built.ok) throw new Error("unexpected");
		expect(
			verifyRuntimeCapabilityPromptPinV0({
				runtime: PI_RUNTIME_V1,
				pin: null,
				systemPromptBody: built.prompt.systemPromptBody,
			}),
		).toMatchObject({ ok: false, reason: "invalid-pin" });

		// Runtime with omitted `aliases` is normalized to `aliases: []` so emitted v1 specs validate cleanly.
		const noAliasRuntime = { executables: ["/usr/bin/node"] };
		const noAliasAgent = join(fresh("no-alias-parent"), "agent");
		makePiAgentDirectoryV1(fakePiDist, noAliasAgent, PI_PROMPT_V1, {
			capabilityConsistentPrompt: true,
			runtime: noAliasRuntime,
			piTools: ["read"],
		});
		const noAliasSpec = piExampleSpecV1({
			agentDirectory: noAliasAgent,
			upstream: "http://127.0.0.1:8091",
			model: "test-model",
			capabilityConsistentPrompt: true,
			runtime: noAliasRuntime,
			piTools: ["read"],
		});
		expect(readEndoProtectedSpecV0(noAliasSpec).ok).toBe(true);
		expect((noAliasSpec.runtime as { aliases: unknown[] }).aliases).toEqual([]);

		// Non-/work cwd is rejected by piExampleSpecV1 because protected-run always launches agents in /work.
		const customCwdAgent = join(fresh("custom-cwd-parent"), "agent");
		makePiAgentDirectoryV1(fakePiDist, customCwdAgent, PI_PROMPT_V1, {
			capabilityConsistentPrompt: true,
			runtime: PI_RUNTIME_V1,
			cwd: "/tmp",
		});
		expect(() =>
			piExampleSpecV1({
				agentDirectory: customCwdAgent,
				upstream: "http://127.0.0.1:8091",
				model: "test-model",
				capabilityConsistentPrompt: true,
				runtime: PI_RUNTIME_V1,
				cwd: "/tmp",
			}),
		).toThrow(/unsupported-cwd/);
	});
});

// ---- Phase 5: residual Pi 1.6.0 dynamic `read` instruction diagnostic ----------------------------------------

describe.runIf(PI_DIST.length > 0)("residual Pi dynamic read-tool instruction audit (ENDO_PI_DIST)", () => {
	it("confirms pinned Pi emits a dynamic `sed` suggestion for lines exceeding 50 KB despite PI_RUNTIME_V1 omitting sed", async () => {
		const readModPath = join(realpathSync(PI_DIST), "core", "tools", "read.js");
		const mod = (await import(pathToFileURL(readModPath).href)) as {
			createReadTool: (cwd: string) => {
				execute: (
					id: string,
					args: { path: string; offset?: number; limit?: number },
				) => Promise<{ content: Array<{ type: string; text?: string }> }>;
			};
		};
		const dir = fresh("long-line-audit");
		// Single line of 60 KiB (> 50 KiB DEFAULT_MAX_BYTES) with no newlines.
		writeFileSync(join(dir, "wide.txt"), "x".repeat(60 * 1024));
		const tool = mod.createReadTool(dir);
		const result = await tool.execute("audit-call-1", { path: "wide.txt" });
		const text = result.content.map((c) => c.text ?? "").join("\n");
		// Record the exact known limitation verified against pinned Pi 1.6.0: initial system-prompt consistency
		// does NOT prevent Pi's own `read` tool from dynamically emitting a `sed` fallback hint on >50 KB lines.
		expect(text).toContain("exceeds 50.0KB limit");
		expect(text).toContain("Use bash: sed -n '1p' wide.txt | head -c 51200");
	});
});
