// `endo workspace open` as the operator runs it: a real process, with NO `pi` on PATH, over a store and a Git repository made by the real
// `endo project`, `endo task` and `endo attempt` commands (a real `endo attempt check` writes the failed receipt). The primary acceptance:
// no agent anywhere, open the workspace, see what needs attention, change a task, stop it, open it again, and find the same durable work.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseEndoWorkspaceArgsV0 } from "../cli/workspace.ts";
import { git, haveGit } from "./git-fixtures.ts";
import { listening } from "./studio-child.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(repo, "cli/index.ts");
const scratch = mkdtempSync(join(tmpdir(), "endo-workspace-cli-"));
const children: ChildProcess[] = [];

beforeAll(() => {
	const built = spawnSync(process.execPath, [join(repo, "scripts/build-studio-ui.mjs")], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`the UI did not build: ${built.stderr}`);
}, 90_000);
afterEach(() => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A PATH with git and nothing else: there is no `pi` (or any harness) to find. HOME and XDG are private to the run. */
function sandbox(name: string): Record<string, string> {
	const bin = join(scratch, name, "bin");
	const home = join(scratch, name, "home");
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });
	const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
	symlinkSync(gitPath, join(bin, "git"));
	return { PATH: bin, HOME: home, XDG_DATA_HOME: join(home, "xdg"), GIT_CONFIG_NOSYSTEM: "1" };
}

const endo = (env: Record<string, string>, ...args: string[]) => {
	const run = spawnSync(process.execPath, [CLI, ...args], { cwd: scratch, env, encoding: "utf8", timeout: 60_000 });
	return { status: run.status, stdout: run.stdout, stderr: run.stderr, json: () => JSON.parse(run.stdout) };
};

interface Host {
	child: ChildProcess;
	port: number;
	capability: string;
	stderr(): string;
	code(): string;
	type(line: string): void;
	call(route: string, init?: { body?: unknown; grant?: string | null }): Promise<{ status: number; body: string }>;
	stop(signal: "SIGINT" | "SIGTERM"): Promise<number | null>;
}

const ADDRESS =
	/^Endophasia workspace \(tasks writable after pairing, no agent\): http:\/\/127\.0\.0\.1:([0-9]+)\/([A-Za-z0-9_-]{43})\/$/m;
const CODE = /pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/g;

function exchange(
	port: number,
	target: string,
	init: { method: string; headers: Record<string, string>; body?: string },
) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path: target,
				method: init.method,
				headers: { Host: `127.0.0.1:${port}`, ...init.headers },
				agent: false,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		req.end(init.body);
	});
}

async function openHost(env: Record<string, string>, root: string, projectId: string): Promise<Host> {
	const child = spawn(process.execPath, [CLI, "workspace", "open", "--root", root, "--project", projectId], {
		cwd: scratch,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	let out = "";
	let err = "";
	child.stdout!.on("data", (c: Buffer) => {
		out += c.toString();
	});
	child.stderr!.on("data", (c: Buffer) => {
		err += c.toString();
	});
	const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
	const deadline = Date.now() + 20_000;
	let match = ADDRESS.exec(out);
	for (; match === null; match = ADDRESS.exec(out)) {
		if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no address; stderr: ${err.slice(0, 500)}`);
		await new Promise((r) => setTimeout(r, 25));
	}
	const port = Number(match[1]);
	const capability = match[2]!;
	let grant: string | null = null;
	const host: Host = {
		child,
		port,
		capability,
		stderr: () => err,
		code: () => [...err.matchAll(CODE)].at(-1)![1]!,
		type: (line) => child.stdin!.write(`${line}\n`),
		call: async (route, init = {}) => {
			const body = init.body === undefined ? undefined : JSON.stringify(init.body);
			const g = init.grant === undefined ? grant : init.grant;
			const reply = await exchange(port, `/${capability}/api/v0/workbench/${route}`, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					...(body === undefined
						? {}
						: {
								Origin: `http://127.0.0.1:${port}`,
								"Content-Type": "application/json",
								"Content-Length": String(Buffer.byteLength(body)),
							}),
					...(g === null ? {} : { "X-Endo-Grant": g }),
				},
				...(body === undefined ? {} : { body }),
			});
			if (route === "pair" && reply.status === 200) grant = (JSON.parse(reply.body) as { grant: string }).grant;
			return reply;
		},
		stop: async (signal) => {
			child.kill(signal);
			return Promise.race([
				closed,
				new Promise<never>((_, fail) =>
					setTimeout(() => fail(new Error(`no exit after ${signal}`)), 10_000).unref(),
				),
			]);
		},
	};
	return host;
}

const waitFor = async (check: () => boolean, what: string) => {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
};

describe("the arguments", () => {
	const parse = (...argv: string[]) => parseEndoWorkspaceArgsV0(argv, { XDG_DATA_HOME: "/data" });
	it("needs a project, takes the store like every command, and refuses what it does not know", () => {
		expect(parse("--project", "p")).toMatchObject({
			projectId: "p",
			root: "/data/endophasia/store",
			port: 0,
			keyFile: null,
		});
		expect(parse("./s", "--project", "p", "--port", "8080")).toMatchObject({
			root: "./s",
			projectId: "p",
			port: 8080,
		});
		expect(parse("--project", "p", "--help")).toBe("help");
		expect(() => parse()).toThrow(/--project <id> is required/);
		expect(() => parse("--project", "p", "--project", "q")).toThrow(/more than once/);
		expect(() => parse("--project", "p", "--port", "08")).toThrow(/--port must be/);
		expect(() => parse("--project", "p", "--cwd", "/etc")).toThrow(/unknown option/);
		expect(() => parse("--project", "p", "--pi", "pi")).toThrow(/unknown option/);
	});
});

(haveGit ? describe : describe.skip)("endo workspace open, with no agent anywhere", () => {
	it("opens, shows what needs attention, takes a task change, stops on Ctrl-C, and reopens to the same durable work", async () => {
		const env = sandbox("journey");
		expect(spawnSync("sh", ["-c", "command -v pi"], { env, encoding: "utf8" }).status).not.toBe(0);
		const root = join(scratch, "journey", "store");
		const project = join(scratch, "journey", "parser");
		mkdirSync(project, { recursive: true });
		git(project, "init", "-q", "-b", "main");
		git(
			project,
			"-c",
			"user.email=a@example.invalid",
			"-c",
			"user.name=Op",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"start",
		);
		// The operator's own CLI: register, add two tasks, prepare an attempt and check it (a real, failing command, recorded as a receipt).
		const added = endo(env, "project", "add", "--root", root, "--name", "Parser", "--path", project);
		expect(added.status).toBe(0);
		const projectId = added.json().project.id as string;
		const failing = endo(
			env,
			"task",
			"add",
			"--root",
			root,
			"--project",
			projectId,
			"--title",
			"Stream the parser",
		).json().task.id as string;
		const quiet = endo(
			env,
			"task",
			"add",
			"--root",
			root,
			"--project",
			projectId,
			"--title",
			"Document the API",
		).json().task.id as string;
		const attempt = endo(
			env,
			"attempt",
			"prepare",
			"--root",
			root,
			"--project",
			projectId,
			"--task",
			failing,
			"--objective",
			"Stream it",
		).json().attempt.attempt.id as string;
		const check = endo(
			env,
			"attempt",
			"check",
			"--root",
			root,
			"--attempt",
			attempt,
			"--timeout",
			"30",
			"--",
			process.execPath,
			"-e",
			"process.exit(1)",
		);
		expect(check.status).toBe(3);

		// Open it. Nothing about a harness is printed or needed.
		const first = await openHost(env, root, projectId);
		expect(first.stderr()).toMatch(/No agent is attached and none is started/);
		const page = await exchange(first.port, `/${first.capability}/`, { method: "GET", headers: {} });
		// The served page says to open on DEVELOP (endo studio serves its page unmarked, byte for byte as built).
		expect([page.status, page.body.includes('<html lang="en" data-start="develop">')]).toEqual([200, true]);
		expect(readFileSync(join(repo, "studio-ui/dist/index.html"), "utf8")).not.toContain("data-start");
		expect(JSON.parse((await first.call("status", { grant: null })).body)).toMatchObject({
			harness: null,
			paired: false,
		});
		expect((await first.call("workspace", { grant: null })).status).toBe(401);
		expect((await first.call("pair", { body: { code: first.code() }, grant: null })).status).toBe(200);

		// What needs attention: the failed check, observed at the current HEAD.
		const attention = JSON.parse((await first.call("workspace/attention")).body) as {
			tasks: { taskId: string; checks: { outcome: string; relation: string }[] }[];
		};
		expect(attention.tasks.find((t) => t.taskId === failing)?.checks).toEqual([
			expect.objectContaining({ outcome: "failed", relation: "at-head" }),
		]);
		// A permitted change from the page, by the store's own rules.
		const seen = JSON.parse((await first.call("workspace")).body) as { tasks: { id: string; revision: number }[] };
		const revision = seen.tasks.find((t) => t.id === quiet)!.revision;
		const moved = await first.call("workspace/tasks/status", {
			body: { taskId: quiet, expectedRevision: revision, to: "in-progress", note: "from the workspace" },
		});
		expect(moved.status).toBe(200);
		// The CLI reads exactly that, and its own change shows on the page's next read.
		expect(
			endo(env, "task", "show", "--root", root, "--project", projectId, "--task", quiet).json().task.status,
		).toBe("in-progress");
		expect(
			endo(env, "task", "status", "--root", root, "--project", projectId, "--task", failing, "--to", "in-progress")
				.status,
		).toBe(0);
		const after = JSON.parse((await first.call("workspace")).body) as { tasks: { id: string; status: string }[] };
		expect(after.tasks.find((t) => t.id === failing)?.status).toBe("in-progress");

		// The terminal ends the grant, and issues a new code.
		first.type("revoke");
		await waitFor(() => first.stderr().includes("grant was revoked"), "the revocation");
		expect((await first.call("workspace")).status).toBe(401);
		const before = [...first.stderr().matchAll(CODE)].length;
		first.type("pair");
		await waitFor(() => [...first.stderr().matchAll(CODE)].length > before, "a new code");
		expect((await first.call("pair", { body: { code: first.code() }, grant: null })).status).toBe(200);

		// Ctrl-C: a clean stop, the port released.
		expect(await first.stop("SIGINT")).toBe(0);
		expect(first.stderr()).toMatch(/workspace: stopped/);
		expect(await listening(first.port)).toBe(false);

		// Reopen: a new launch and capability, the same work.
		const second = await openHost(env, root, projectId);
		expect(second.capability).not.toBe(first.capability);
		expect((await second.call("pair", { body: { code: second.code() }, grant: null })).status).toBe(200);
		const again = JSON.parse((await second.call("workspace")).body) as {
			tasks: { id: string; status: string; history: { note: string | null }[] }[];
		};
		expect(again.tasks.find((t) => t.id === quiet)).toMatchObject({ status: "in-progress" });
		expect(again.tasks.find((t) => t.id === quiet)?.history.at(-1)?.note).toBe("from the workspace");
		const recheck = JSON.parse((await second.call("workspace/attention")).body) as typeof attention;
		expect(recheck.tasks.find((t) => t.taskId === failing)?.checks[0]).toMatchObject({ outcome: "failed" });
		expect(await second.stop("SIGTERM")).toBe(0);
		// Nothing in the project's directory was written by any of it.
		expect(git(project, "status", "--porcelain")).toBe("");
		expect(readFileSync(join(root, "develop", "tasks.json"), "utf8")).toContain("from the workspace");
	}, 120_000);

	it("refuses to start for an unknown project, naming the registered ones, and for bad arguments with status 2", () => {
		const env = sandbox("refusals");
		const root = join(scratch, "refusals", "store");
		const project = join(scratch, "refusals", "p");
		mkdirSync(project, { recursive: true });
		const id = endo(env, "project", "add", "--root", root, "--name", "P", "--path", project).json().project
			.id as string;
		const unknown = endo(env, "workspace", "open", "--root", root, "--project", "endo.project.nope");
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toContain(`Registered: ${id}`);
		const bad = endo(env, "workspace", "open", "--root", root);
		expect(bad.status).toBe(2);
		expect(bad.stderr).toMatch(/--project <id> is required/);
		const help = endo(env, "workspace", "open", "--help");
		expect(help.status).toBe(0);
		expect(help.stdout).toMatch(/cannot send a prompt, steer, queue or stop an agent/);
	});
});
