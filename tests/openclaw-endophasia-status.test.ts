// The OpenClaw plugin for COORDINATOR-STATUS-001 (integrations/openclaw-endophasia-status).
//
// - Mocked OpenClaw boundary: the plugin definition is built against a fake `defineToolPlugin` and `Type`, and its one tool is driven the
//   way OpenClaw drives a declarative tool (`execute(params, config, context)`), both with a fake runner (to pin the exact command and the
//   unavailable paths) and with the real runner against a real store, where the read is proven to write nothing.
// - Sandbox: on a host with bubblewrap, the default sandbox is shown read-only from the inside (a write fails with EROFS) with the
//   credential stores masked, which is a negative control for the read-only claim that does not depend on Endophasia's own code.
// - Real SDK: on a host with OpenClaw installed, the same definition is bound to the installed `defineToolPlugin` and its metadata read.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	createEndophasiaStatusPluginV0,
	ENDOPHASIA_STATUS_TOOL_NAME,
	type ToolDefinitionV0,
	type TypeBuilderV0,
} from "../integrations/openclaw-endophasia-status/src/plugin.ts";
import {
	type EndophasiaCommandV0,
	type EndophasiaRunV0,
	endophasiaStatusCommandV0,
	execEndophasiaV0,
	validateEndophasiaStatusConfigV0,
} from "../integrations/openclaw-endophasia-status/src/status-reader.ts";
import { validateEndoCoordinatorStatusV0 } from "../protocol/coordinator-status.ts";
import {
	buildCoordinatorStoreV0,
	COORDINATOR_FIXTURE_SESSION_V0,
	cleanCoordinatorFixturesV0,
	coordinatorTempDirV0,
} from "./coordinator-status-fixture.ts";
import { manifestOf } from "./read-only-manifest.ts";

afterEach(cleanCoordinatorFixturesV0);

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const PROJECT = "endo.project.0123456789abcdef0123456789abcdef";
const BWRAP = "/usr/bin/bwrap";
const bwrapWorks = existsSync(BWRAP) && spawnSync(BWRAP, ["--unshare-all", "--ro-bind", "/", "/", "true"]).status === 0;
const OPENCLAW_SDK = join(homedir(), ".local/lib/node_modules/openclaw/dist/plugin-sdk/tool-plugin.js");

/** A stand-in for TypeBox: records the schema shape as plain JSON-schema-like objects. */
const FakeType: TypeBuilderV0 = {
	Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
	Optional: (schema) => ({ ...(schema as object), optional: true }),
	String: (options = {}) => ({ type: "string", ...options }),
	Boolean: (options = {}) => ({ type: "boolean", ...options }),
	Integer: (options = {}) => ({ type: "integer", ...options }),
	Array: (items, options = {}) => ({ type: "array", items, ...options }),
	Union: (anyOf, options = {}) => ({ anyOf, ...options }),
	Literal: (value) => ({ const: value }),
};

/** The mocked OpenClaw boundary: a `defineToolPlugin` that keeps what it was given and returns the declared tools. */
function mockedOpenClaw(run?: EndophasiaRunV0) {
	let definition: Parameters<Parameters<typeof createEndophasiaStatusPluginV0>[0]["defineToolPlugin"]>[0] | undefined;
	createEndophasiaStatusPluginV0(
		{
			defineToolPlugin: (d) => {
				definition = d;
				return d;
			},
			Type: FakeType,
		},
		run,
	);
	if (definition === undefined) throw new Error("defineToolPlugin was not called");
	const tools = definition.tools((t: ToolDefinitionV0) => t) as ToolDefinitionV0[];
	return { definition, tools, tool: tools[0] as ToolDefinitionV0 };
}

function config(over: Record<string, unknown> = {}) {
	return {
		endo: { node: process.execPath, entry: CLI },
		storeRoot: "/store",
		projects: [{ id: PROJECT, label: "alpha" }],
		sandbox: "none",
		...over,
	};
}

const recorder = (stdout = "{}", code = 0, error: string | null = null) => {
	const calls: EndophasiaCommandV0[] = [];
	const run: EndophasiaRunV0 = async (command) => {
		calls.push(command);
		return { code, signal: null, stdout, error };
	};
	return { calls, run };
};

describe("endophasia-status plugin against a mocked OpenClaw boundary", () => {
	it("declares one optional, read-only tool whose only parameter is a permitted project", () => {
		const { definition, tools, tool } = mockedOpenClaw();
		expect(definition.id).toBe("endophasia-status");
		expect(tools.map((t) => t.name)).toEqual([ENDOPHASIA_STATUS_TOOL_NAME]);
		expect(tool.optional).toBe(true);
		const params = tool.parameters as { properties: Record<string, unknown>; additionalProperties: boolean };
		expect(Object.keys(params.properties)).toEqual(["project"]);
		expect(params.additionalProperties).toBe(false);
		expect((definition.configSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
		expect(tool.description).toContain("cannot change anything");
	});

	it("runs exactly one fixed command built from config: no shell, scrubbed env, every permitted project", async () => {
		const { calls, run } = recorder("not json");
		const { tool } = mockedOpenClaw(run);
		await tool.execute({}, config({ staleAfterSeconds: 120 }), {});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			file: process.execPath,
			args: [
				CLI,
				"coordinator",
				"status",
				"--quiet",
				"--root",
				"/store",
				"--stale-after",
				"120",
				"--project",
				PROJECT,
			],
			env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: homedir(), LANG: "C.UTF-8" },
		});
	});

	it("refuses a project outside the allowlist without running anything, whatever the model passes", async () => {
		const { calls, run } = recorder();
		const { tool } = mockedOpenClaw(run);
		for (const project of [
			"--root /etc",
			"endo.project.ffffffffffffffffffffffffffffffff",
			"../../",
			"alpha; rm -rf ~",
		]) {
			const out = (await tool.execute({ project }, config(), {})) as { ok: boolean; error: string };
			expect(out.ok).toBe(false);
			expect(out.error).toContain("is not a permitted project");
		}
		expect(calls).toEqual([]);
		const named = recorder("x");
		await mockedOpenClaw(named.run).tool.execute({ project: "ALPHA" }, config(), {});
		expect(named.calls[0]!.args.slice(-2)).toEqual(["--project", PROJECT]);
	});

	it("refuses a config that is relative, open-ended or carries unknown keys", async () => {
		const { calls, run } = recorder();
		const { tool } = mockedOpenClaw(run);
		for (const bad of [
			config({ storeRoot: "relative/store" }),
			config({ endo: { node: "node", entry: CLI } }),
			config({ projects: [] }),
			config({ projects: [{ id: "*" }] }),
			config({ extraArgs: ["--write"] }),
			config({ sandbox: "host" }),
		]) {
			const out = (await tool.execute({}, bad, {})) as { ok: boolean; error: string };
			expect(out.ok).toBe(false);
			expect(out.error).toContain("not configured correctly");
		}
		expect(calls).toEqual([]);
	});

	it("reports Endophasia unavailable, with a closed reason, rather than guessing", async () => {
		const cases: [ReturnType<typeof recorder>, string][] = [
			[recorder("", 1), "exited-nonzero"],
			[recorder("", null as never, "timed-out"), "timed-out"],
			[recorder("", null as never, "spawn-failed"), "spawn-failed"],
			[recorder("{ not json"), "not-json"],
			[
				recorder(JSON.stringify({ coordinatorStatus: { schemaVersion: "endo.coordinator-status.v9" } })),
				"invalid-status",
			],
		];
		for (const [rec, reason] of cases) {
			const out = (await mockedOpenClaw(rec.run).tool.execute({}, config(), {})) as Record<string, unknown>;
			expect(out).toMatchObject({ ok: true, availability: "unavailable" });
			expect(out.summary).toContain(reason);
			expect(out.summary).toContain("do not infer any");
			expect(out).not.toHaveProperty("coordinatorStatus");
			expect(out).not.toHaveProperty("status");
		}
	});

	it("builds a bubblewrap sandbox by default: read-only root, no network, credential stores masked, clean env", () => {
		const home = "/home/op";
		const c = validateEndophasiaStatusConfigV0({ ...config(), sandbox: undefined });
		const cmd = endophasiaStatusCommandV0(
			c,
			[PROJECT],
			home,
			(p) => p === "/home/op/.openclaw" || p === "/home/op/.ssh",
		);
		expect(cmd.file).toBe(BWRAP);
		const a = cmd.args;
		expect(a.slice(0, 6)).toEqual(["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/", "/"]);
		expect(a.join(" ")).toContain("--tmpfs /home/op/.openclaw --tmpfs /home/op/.ssh --clearenv");
		expect(a).not.toContain("--bind");
		expect(a).not.toContain("--share-net");
		expect(a.slice(a.indexOf("--") + 1, a.indexOf("--") + 3)).toEqual([process.execPath, CLI]);
	});
});

describe("endophasia-status plugin end to end (real CLI, real store)", () => {
	const variants = [["none", true] as const, ["bwrap", bwrapWorks] as const];
	for (const [sandbox, enabled] of variants)
		it.skipIf(!enabled)(`answers from the real status and writes nothing (sandbox: ${sandbox})`, async () => {
			const f = await buildCoordinatorStoreV0();
			const before = { store: manifestOf(f.root), repo: manifestOf(f.repo) };
			const { tool } = mockedOpenClaw(execEndophasiaV0);
			const out = (await tool.execute(
				{ project: "disk" },
				config({ storeRoot: f.root, projects: [{ id: f.projectId, label: "disk" }], sandbox }),
				{},
			)) as Record<string, unknown>;
			expect({ store: manifestOf(f.root), repo: manifestOf(f.repo) }).toEqual(before);
			expect(out).toMatchObject({
				ok: true,
				availability: "available",
				provenance: { sandbox, projects: [f.projectId] },
			});
			const status = validateEndoCoordinatorStatusV0(out.coordinatorStatus);
			expect(status.projects[0]!.tasks[0]).toMatchObject({ phase: "awaiting-review", title: "[not disclosed]" });
			const summary = out.summary as string;
			expect(summary).toContain("1 awaiting review");
			expect(summary).toContain("verification passing-at-head [fresh]");
			expect(summary).toContain("no session is linked by any record (relationship unknown)");
			expect(summary).toContain(
				"1 more session(s) in the store have no recorded relationship to them (1 of those active, not listed)",
			);
			expect(summary).not.toContain("Make ok.mjs succeed");
			expect(JSON.stringify(out)).not.toContain(COORDINATOR_FIXTURE_SESSION_V0);
		});

	it("discloses task titles only when the operator configures it", async () => {
		const f = await buildCoordinatorStoreV0();
		const out = (await mockedOpenClaw(execEndophasiaV0).tool.execute(
			{},
			config({ storeRoot: f.root, projects: [{ id: f.projectId }], disclose: { taskTitles: true } }),
			{},
		)) as { summary: string };
		expect(out.summary).toContain('"Make ok.mjs succeed"');
	});

	it.skipIf(!bwrapWorks)(
		"negative control: inside the sandbox a write fails with EROFS and the credential stores read empty",
		() => {
			const scratch = coordinatorTempDirV0("endo-coord-sandbox-");
			const fakeHome = join(scratch, "home");
			mkdirSync(join(fakeHome, ".openclaw"), { recursive: true });
			writeFileSync(join(fakeHome, ".openclaw", "openclaw.json"), '{"secret":"canary"}');
			const probe = join(scratch, "probe.mjs");
			writeFileSync(
				probe,
				[
					'import { readdirSync, writeFileSync } from "node:fs";',
					"const target = process.argv[process.argv.indexOf('--root') + 1];",
					"let write = 'written';",
					"try { writeFileSync(target + '/probe-write', 'x'); } catch (e) { write = e.code; }",
					"const masked = readdirSync(process.env.HOME + '/.openclaw');",
					"const interfaces = Object.keys((await import('node:os')).networkInterfaces()).sort();",
					"console.log(JSON.stringify({ write, masked, interfaces, env: Object.keys(process.env).sort() }));",
				].join("\n"),
			);
			const c = validateEndophasiaStatusConfigV0({
				...config({ storeRoot: scratch }),
				endo: { node: process.execPath, entry: probe },
				sandbox: "bwrap",
			});
			const cmd = endophasiaStatusCommandV0(c, [PROJECT], fakeHome);
			const run = spawnSync(cmd.file, cmd.args, { env: cmd.env, encoding: "utf8" });
			expect(run.status, run.stderr).toBe(0);
			const seen = JSON.parse(run.stdout) as {
				write: string;
				masked: string[];
				interfaces: string[];
				env: string[];
			};
			expect(seen.write).toBe("EROFS");
			expect(seen.masked).toEqual([]);
			// A private network namespace: at most its own loopback, none of the host's interfaces.
			expect(seen.interfaces.filter((i) => i !== "lo")).toEqual([]);
			// bubblewrap itself sets PWD after --clearenv; nothing of the caller's environment crosses.
			expect(seen.env).toEqual(["HOME", "LANG", "PATH", "PWD"]);
			expect(readdirSync(scratch).sort()).toEqual(["home", "probe.mjs"]);
			// Control for the control: the same probe outside the sandbox can write, so EROFS above is the sandbox's doing.
			const outside = spawnSync(process.execPath, [probe, "--root", scratch], {
				env: { ...cmd.env, HOME: fakeHome },
				encoding: "utf8",
			});
			expect(JSON.parse(outside.stdout).write).toBe("written");
			expect(JSON.parse(outside.stdout).masked).toEqual(["openclaw.json"]);
			expect(JSON.parse(outside.stdout).interfaces.some((i: string) => i !== "lo")).toBe(true);
		},
	);
});

describe("endophasia-status plugin against the installed OpenClaw SDK (host only)", () => {
	it.skipIf(!existsSync(OPENCLAW_SDK))(
		"binds to the real defineToolPlugin and declares endophasia_status",
		async () => {
			const sdk = (await import(OPENCLAW_SDK)) as {
				defineToolPlugin: Parameters<typeof createEndophasiaStatusPluginV0>[0]["defineToolPlugin"];
				getToolPluginMetadata: (entry: unknown) => {
					id: string;
					tools: { name: string; optional?: boolean; parameters: unknown }[];
				};
			};
			const typebox = (await import(
				join(homedir(), ".local/lib/node_modules/openclaw/node_modules/typebox/build/index.mjs")
			)) as {
				Type: TypeBuilderV0;
			};
			const entry = createEndophasiaStatusPluginV0({ defineToolPlugin: sdk.defineToolPlugin, Type: typebox.Type });
			const meta = sdk.getToolPluginMetadata(entry);
			expect(meta.id).toBe("endophasia-status");
			expect(meta.tools.map((t) => [t.name, t.optional])).toEqual([["endophasia_status", true]]);
			expect(JSON.stringify(meta.tools[0]!.parameters)).toContain('"project"');
		},
	);
});
