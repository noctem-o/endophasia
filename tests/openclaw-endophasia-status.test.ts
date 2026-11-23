// The OpenClaw plugin for COORDINATOR-STATUS-001 (integrations/openclaw-endophasia-status).
//
// - Mocked OpenClaw boundary: the plugin definition is built against a fake `defineToolPlugin` and `Type`, and its one tool is driven the
//   way OpenClaw drives a declarative tool (`execute(params, config, context)`), both with a fake runner (to pin the exact command and the
//   unavailable paths) and with the real runner against a real store, where the read is proven to write nothing.
// - Sandbox: the shipped reader has no unsandboxed mode. A missing or failing bubblewrap is shown, with the real runner, to yield
//   `unavailable` without endo ever running. Tests that need endo to run on a host without bubblewrap inject `unwrapped`, a test-only
//   runner that strips the bwrap prefix, so the opt-out lives here and not in the plugin's config.
// - On a host with bubblewrap, the sandbox is shown read-only from the inside (a write fails with EROFS) with the
//   credential stores masked, which is a negative control for the read-only claim that does not depend on Endophasia's own code.
// - Real SDK: on a host with OpenClaw installed, the same definition is bound to the installed `defineToolPlugin` and its metadata read.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
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
		projects: [{ id: PROJECT, root: "/repo/alpha", label: "alpha" }],
		...over,
	};
}

/** Test-only: run the command bubblewrap would have run, without bubblewrap. Asserts it was handed a bwrap command first. */
const unwrapped: EndophasiaRunV0 = (command, options) => {
	expect(command.file).toBe(BWRAP);
	const inner = command.args.slice(command.args.indexOf("--") + 1);
	return execEndophasiaV0({ file: inner[0]!, args: inner.slice(1), env: command.env }, options);
};

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
		const call = calls[0]!;
		expect(call.file).toBe(BWRAP);
		expect({
			...call,
			file: call.args[call.args.indexOf("--") + 1],
			args: call.args.slice(call.args.indexOf("--") + 2),
		}).toEqual({
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
			env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
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
			config({ sandbox: "none" }),
			config({ sandbox: "bwrap" }),
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

	it("always builds a bubblewrap sandbox over an empty root: only what the read needs is mounted, read-only", () => {
		const host = {
			exists: (p: string) => p === "/opt/endo/package.json" || p === "/opt/endo/node_modules",
			link: (p: string) => (p === "/lib" ? "usr/lib" : p === "/bin" ? "usr/bin" : null),
			text: (p: string) =>
				p === "/repo/alpha/.git"
					? "gitdir: /repo/main/.git/worktrees/alpha\n"
					: p.endsWith("/commondir")
						? "../..\n"
						: null,
			real: (p: string) => p,
		};
		const c = validateEndophasiaStatusConfigV0(
			config({
				endo: { node: "/usr/bin/node", entry: "/opt/endo/cli/index.ts" },
				storeRoot: "/home/op/.local/share/endophasia/store",
				projects: [
					{ id: PROJECT, root: "/repo/alpha", label: "alpha" },
					{ id: "endo.project.ffffffffffffffffffffffffffffffff", root: "/repo/other" },
				],
			}),
		);
		const cmd = endophasiaStatusCommandV0(c, [PROJECT], host);
		expect(cmd.file).toBe(BWRAP);
		const a = cmd.args;
		const binds = (flag: string) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
		expect(a.slice(0, 5)).toEqual(["--die-with-parent", "--new-session", "--unshare-all", "--tmpfs", "/tmp"]);
		expect(binds("--ro-bind")).toEqual(["/usr", "/opt/endo", "/repo/alpha"]);
		expect(binds("--ro-bind-try")).toEqual([
			"/sbin",
			"/lib64",
			"/etc/ld.so.cache",
			"/etc/localtime",
			"/etc/passwd",
			"/etc/group",
			"/etc/nsswitch.conf",
			"/home/op/.local/share/endophasia/store/develop",
			"/home/op/.local/share/endophasia/store/events",
			"/repo/main/.git/worktrees/alpha",
			"/repo/main/.git",
		]);
		expect(a.join(" ")).toContain("--symlink usr/bin /bin");
		// No whole-host bind, no writable bind, no network, nothing of the home directory or the store's control socket.
		expect(a.join(" ")).not.toMatch(
			/--ro-bind \/ \/|--bind |--share-net|\/home\/op\/\.openclaw|\/store\/control|\/repo\/other/,
		);
		expect(a.slice(a.indexOf("--") + 1, a.indexOf("--") + 3)).toEqual(["/usr/bin/node", "/opt/endo/cli/index.ts"]);
	});

	it("refuses a config whose project has no absolute root, or the filesystem root", async () => {
		const { calls, run } = recorder();
		const { tool } = mockedOpenClaw(run);
		for (const projects of [[{ id: PROJECT }], [{ id: PROJECT, root: "repo" }], [{ id: PROJECT, root: "/" }]]) {
			const out = (await tool.execute({}, config({ projects }), {})) as { ok: boolean; error: string };
			expect(out.error).toContain("root");
		}
		expect(calls).toEqual([]);
	});

	it("refuses a status whose returned scope does not match the request", async () => {
		const f = await buildCoordinatorStoreV0();
		const other = spawnSync(process.execPath, [CLI, "coordinator", "status", "--quiet", "--root", f.root], {
			encoding: "utf8",
		});
		expect(other.status, other.stderr).toBe(0);
		const out = (await mockedOpenClaw(recorder(other.stdout).run).tool.execute(
			{},
			config({ storeRoot: f.root, projects: [{ id: f.projectId, root: f.repo }] }),
			{},
		)) as { availability: string; summary: string };
		expect(out.availability).toBe("unavailable");
		expect(out.summary).toContain("returned scope does not match");
	});
});

describe("endophasia-status plugin end to end (real CLI, real store)", () => {
	const variants = [
		["test-only unwrapped runner", unwrapped, true],
		["real bwrap", execEndophasiaV0, bwrapWorks],
	] as const;
	for (const [name, run, enabled] of variants)
		it.skipIf(!enabled)(`answers from the real status and writes nothing (${name})`, async () => {
			const f = await buildCoordinatorStoreV0();
			const before = { store: manifestOf(f.root), repo: manifestOf(f.repo) };
			const { tool } = mockedOpenClaw(run);
			const out = (await tool.execute(
				{ project: "disk" },
				config({ storeRoot: f.root, projects: [{ id: f.projectId, root: f.repo, label: "disk" }] }),
				{},
			)) as Record<string, unknown>;
			expect({ store: manifestOf(f.root), repo: manifestOf(f.repo) }).toEqual(before);
			expect(out).toMatchObject({
				ok: true,
				availability: "available",
				provenance: { sandbox: "bwrap", projects: [f.projectId] },
			});
			const status = out.status as { projects: { project: string; tasks: Record<string, unknown>[] }[] };
			expect(status.projects[0]!.project).toBe("disk");
			expect(status.projects[0]!.tasks[0]).toMatchObject({ phase: "awaiting-review" });
			expect(status.projects[0]!.tasks[0]).not.toHaveProperty("title");
			const summary = out.summary as string;
			expect(summary).toContain("1 awaiting review");
			expect(summary).toContain("verification passing-at-head [fresh]");
			expect(summary).toContain("no session is linked by any record (relationship unknown)");
			expect(summary).toContain("Sessions with no recorded link to these projects are not counted in this answer.");
			expect(summary).not.toContain("Make ok.mjs succeed");
			expect(JSON.stringify(out)).not.toContain(COORDINATOR_FIXTURE_SESSION_V0);
			expect(out.status).not.toHaveProperty("unlistedSessions");
			expect(out).not.toHaveProperty("coordinatorStatus");
		});

	it("discloses task titles only when the operator configures it", async () => {
		const f = await buildCoordinatorStoreV0();
		const out = (await mockedOpenClaw(unwrapped).tool.execute(
			{},
			config({ storeRoot: f.root, projects: [{ id: f.projectId, root: f.repo }], disclose: { taskTitles: true } }),
			{},
		)) as { summary: string };
		expect(out.summary).toContain('"Make ok.mjs succeed"');
	});

	it.skipIf(!bwrapWorks)(
		"negative control: inside the sandbox only the mounted paths exist, all read-only, with no host network",
		() => {
			const scratch = coordinatorTempDirV0("endo-coord-sandbox-");
			const store = join(scratch, "store");
			const project = join(scratch, "project");
			const code = join(scratch, "code");
			for (const d of ["develop", "events", "control"]) mkdirSync(join(store, d), { recursive: true });
			writeFileSync(join(store, "develop", "tasks.json"), "{}");
			writeFileSync(join(store, "control", "endpoint.sock"), "stand-in for the control socket path");
			mkdirSync(join(project, ".git"), { recursive: true });
			mkdirSync(join(scratch, "home", ".openclaw"), { recursive: true });
			writeFileSync(join(scratch, "home", ".openclaw", "openclaw.json"), '{"secret":"canary"}');
			mkdirSync(join(scratch, "unrequested-project"), { recursive: true });
			writeFileSync(join(scratch, "unrequested-project", "secret.txt"), "canary");
			mkdirSync(code, { recursive: true });
			const probe = join(code, "probe.mjs");
			const paths = {
				storeFile: join(store, "develop", "tasks.json"),
				write: join(store, "develop", "probe-write"),
				control: join(store, "control", "endpoint.sock"),
				credential: join(scratch, "home", ".openclaw", "openclaw.json"),
				unrequested: join(scratch, "unrequested-project", "secret.txt"),
				hostHome: homedir(),
			};
			writeFileSync(
				probe,
				[
					'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
					`const p = ${JSON.stringify(paths)};`,
					"let write = 'written';",
					"try { writeFileSync(p.write, 'x'); } catch (e) { write = e.code; }",
					"const seen = Object.fromEntries(['storeFile', 'control', 'credential', 'unrequested', 'hostHome'].map((k) => [k, existsSync(p[k])]));",
					"const interfaces = Object.keys((await import('node:os')).networkInterfaces()).sort();",
					"console.log(JSON.stringify({ write, seen, interfaces, env: Object.keys(process.env).sort(), store: readFileSync(p.storeFile, 'utf8') }));",
				].join("\n"),
			);
			const c = validateEndophasiaStatusConfigV0({
				...config({ storeRoot: store, projects: [{ id: PROJECT, root: project }] }),
				endo: { node: process.execPath, entry: probe },
			});
			const cmd = endophasiaStatusCommandV0(c, [PROJECT]);
			const run = spawnSync(cmd.file, cmd.args, { env: cmd.env, encoding: "utf8" });
			expect(run.status, run.stderr).toBe(0);
			const inside = JSON.parse(run.stdout) as {
				write: string;
				seen: Record<string, boolean>;
				interfaces: string[];
				env: string[];
				store: string;
			};
			expect(inside.write).toBe("EROFS");
			expect(inside.store).toBe("{}");
			expect(inside.seen).toEqual({
				storeFile: true,
				control: false,
				credential: false,
				unrequested: false,
				hostHome: paths.hostHome.startsWith(scratch),
			});
			expect(inside.interfaces.filter((i) => i !== "lo")).toEqual([]);
			expect(inside.env).toEqual(["HOME", "LANG", "PATH"].concat(inside.env.includes("PWD") ? ["PWD"] : []).sort());
			// Control for the control: outside the sandbox the same probe writes and sees every one of those paths.
			const outside = spawnSync(process.execPath, [probe], { env: cmd.env, encoding: "utf8" });
			const seenOutside = JSON.parse(outside.stdout) as typeof inside;
			expect(seenOutside.write).toBe("written");
			expect(seenOutside.seen).toEqual({
				storeFile: true,
				control: true,
				credential: true,
				unrequested: true,
				hostHome: true,
			});
			expect(seenOutside.interfaces.some((i) => i !== "lo")).toBe(true);
		},
	);
});

describe("endophasia-status plugin returns only what a status answer needs (real CLI, real store)", () => {
	const CANARY = "CANARY-7f3a9c";

	it("drops argv-derived command strings, identifiers, commit ids, project names and store-wide counts unless detail is disclosed", async () => {
		const f = await buildCoordinatorStoreV0({ checkArgv: ["node", "ok.mjs", CANARY] });
		const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).stdout.trim();
		const base = config({ storeRoot: f.root, projects: [{ id: f.projectId, root: f.repo }] });
		const out = (await mockedOpenClaw(unwrapped).tool.execute({}, base, {})) as Record<string, unknown>;
		expect(out.availability).toBe("available");
		const text = JSON.stringify(out);
		for (const secret of [
			CANARY,
			COORDINATOR_FIXTURE_SESSION_V0,
			"disk-0001",
			head,
			head.slice(0, 12),
			"Disk Demo",
			"endo.receipt.",
		])
			expect(text).not.toContain(secret);
		expect(out).not.toHaveProperty("coordinatorStatus");
		expect(out.status).not.toHaveProperty("unlistedSessions");

		const detailed = (await mockedOpenClaw(unwrapped).tool.execute(
			{},
			{ ...base, disclose: { detail: true } },
			{},
		)) as Record<string, unknown>;
		// The canary really was in the record: only the explicit detail setting returns it.
		expect(JSON.stringify(detailed.coordinatorStatus)).toContain(CANARY);
		expect(JSON.stringify(detailed.coordinatorStatus)).toContain("[not disclosed]");
	});

	it("keeps a completed task's qualification in the summary", async () => {
		const f = await buildCoordinatorStoreV0();
		const tasks = new DevelopTasksStoreV0(f.root);
		const moved = tasks.setStatus(f.projectId, f.taskId, f.revision, "done", null);
		expect(moved.ok).toBe(true);
		const out = (await mockedOpenClaw(unwrapped).tool.execute(
			{},
			config({ storeRoot: f.root, projects: [{ id: f.projectId, root: f.repo }] }),
			{},
		)) as { summary: string };
		expect(out.summary).toContain(`- [completed] ${f.taskId}: gaps: completed-not-reverified.`);
	});
});

describe("endophasia-status plugin fails closed when bubblewrap is unavailable (real runner)", () => {
	function failClosedProbe() {
		const scratch = coordinatorTempDirV0("endo-coord-failclosed-");
		const marker = join(scratch, "endo-ran");
		const entry = join(scratch, "endo.mjs");
		writeFileSync(
			entry,
			`import { writeFileSync } from "node:fs"; try { writeFileSync(${JSON.stringify(marker)}, "ran"); } catch {} console.log("ENDO-RAN");`,
		);
		const failingBwrap = join(scratch, "bwrap-userns-denied");
		writeFileSync(failingBwrap, "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n");
		chmodSync(failingBwrap, 0o755);
		let stdout = "";
		const run: EndophasiaRunV0 = async (command, options) => {
			const ran = await execEndophasiaV0(command, options);
			stdout = ran.stdout;
			return ran;
		};
		const read = async (bwrapPath: string) =>
			(await mockedOpenClaw(run).tool.execute(
				{},
				config({
					storeRoot: scratch,
					projects: [{ id: PROJECT, root: scratch }],
					endo: { node: process.execPath, entry },
					bwrapPath,
				}),
				{},
			)) as { availability: string; summary: string; provenance: { sandbox: string } };
		return { scratch, marker, failingBwrap, read, stdout: () => stdout };
	}

	it("bwrap missing or unable to start => unavailable, and endo never runs directly", async () => {
		const p = failClosedProbe();
		for (const [bwrapPath, reason] of [
			[join(p.scratch, "no-such-bwrap"), "spawn-failed"],
			[p.failingBwrap, "exited-nonzero"],
		] as const) {
			const out = await p.read(bwrapPath);
			expect(out.availability).toBe("unavailable");
			expect(out.summary).toContain(reason);
			expect(out.provenance.sandbox).toBe("bwrap");
			expect(p.stdout()).not.toContain("ENDO-RAN");
			expect(existsSync(p.marker)).toBe(false);
		}
	});

	it.skipIf(!bwrapWorks)(
		"control: with a working bwrap the same entry does run, inside the read-only sandbox",
		async () => {
			const p = failClosedProbe();
			const out = await p.read(BWRAP);
			expect(out.availability).toBe("unavailable");
			expect(out.summary).toContain("not-json");
			expect(p.stdout()).toContain("ENDO-RAN");
			expect(existsSync(p.marker)).toBe(false);
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
