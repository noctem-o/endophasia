// The shared workspace service (runtime/contracts/develop-workspace.ts): one implementation of the project and task operations for every caller.
// In-process tests of the operator and launch scopes, the CLI and the workbench writing the same file, writers of both scopes in
// concurrent processes, a non-Pi consumer as its own process, and an import walk proving the service and that consumer need no harness.
// Real files and processes; a fake Pi session where a workbench is needed; no Pi, no model, no network.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { piEndoSessionIdV0 } from "../adapters/pi/mapping.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import type { EndoDevelopWorkspaceViewV0 } from "../protocol/develop-tasks.ts";
import {
	type DevelopLaunchHostV0,
	DevelopLaunchWorkspaceV0,
	DevelopWorkspaceServiceV0,
} from "../runtime/contracts/develop-workspace.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { Approval, FakeDesk, FakeSession } from "./workbench-fixtures.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "cli", "index.ts");
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-workspace-service-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const dir = join(base, `${name}-${made}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const fileOf = (root: string) => readFileSync(join(root, "develop", "tasks.json"), "utf8");
const noGit = { observeGitRoot: async () => null };

/** A store root with one registered project, through the service (with Git's observation stubbed). */
async function registered() {
	const root = fresh("root");
	const dir = fresh("project");
	const service = new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root), noGit);
	const project = await service.registerProject({ name: "demo", path: dir });
	if (!project.ok) throw new Error(project.code);
	return { root, dir, service, projectId: project.value.id };
}

const LAUNCH_A = "a1a1a1a1a1a1a1a1";
const LAUNCH_B = "b2b2b2b2b2b2b2b2";
/** A Pi host as the workbench is one: the canonical session id, while connected. */
function piHost(launchId: string, connected: { id: string | null }): DevelopLaunchHostV0 {
	return {
		launchId,
		attachment: "pi.default",
		session: {
			source: "pi-live",
			current: () => (connected.id === null ? null : { sessionId: piEndoSessionIdV0(connected.id) }),
		},
	};
}

describe("the operator scope (what the CLI uses)", () => {
	it("registers only an existing directory, resolves links, keeps Git's answer as an observation, and refuses a second registration", async () => {
		const root = fresh("root");
		const dir = fresh("project");
		const seen: string[] = [];
		const service = new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root), {
			observeGitRoot: async (d) => {
				seen.push(d);
				return d;
			},
		});
		expect(await service.registerProject({ name: "x", path: join(dir, "absent") })).toEqual({
			ok: false,
			code: "not-a-directory",
		});
		writeFileSync(join(dir, "file"), "");
		expect(await service.registerProject({ name: "x", path: join(dir, "file") })).toEqual({
			ok: false,
			code: "not-a-directory",
		});
		expect(existsSync(join(root, "develop"))).toBe(false);
		const first = await service.registerProject({ name: "demo", path: `${dir}/.` });
		expect(first).toMatchObject({ ok: true, value: { path: dir, observedGitRoot: dir } });
		expect(seen).toEqual([dir]);
		expect(await service.registerProject({ name: "again", path: dir })).toEqual({ ok: false, code: "duplicate" });
	});

	it("reads a project's tasks, refuses an unknown project, and changes a status only by the file's rules and revision", async () => {
		const w = await registered();
		expect(w.service.tasks(`endo.project.${"0".repeat(32)}`)).toEqual({ ok: false, code: "not-found" });
		const task = w.service.createTask(w.projectId, { title: "One" });
		if (!task.ok) throw new Error(task.code);
		expect(w.service.setStatus(w.projectId, task.value.id, 0, "done")).toEqual({
			ok: false,
			code: "invalid-transition",
		});
		const moved = w.service.setStatus(w.projectId, task.value.id, 0, "in-progress", "started");
		expect(moved).toMatchObject({ ok: true, value: { status: "in-progress", revision: 1 } });
		const before = fileOf(w.root);
		expect(w.service.setStatus(w.projectId, task.value.id, 0, "review")).toEqual({
			ok: false,
			code: "stale-revision",
		});
		expect(fileOf(w.root)).toBe(before);
		expect(w.service.task(w.projectId, task.value.id)).toMatchObject({ ok: true, value: { revision: 1 } });
	});
});

describe("the launch scope (what the workbench uses)", () => {
	it("is writable only from the registered directory; a mismatched or missing one, an unknown project or a damaged file changes nothing", async () => {
		const w = await registered();
		const seed = w.service.createTask(w.projectId, { title: "Seed" });
		if (!seed.ok) throw new Error(seed.code);
		const host = piHost(LAUNCH_A, { id: "s1" });
		const tryAll = (scope: DevelopLaunchWorkspaceV0) => [
			scope.createTask({ title: "x" }),
			scope.updateTask(seed.value.id, 0, { title: "y" }),
			scope.setStatus(seed.value.id, 0, "in-progress"),
			scope.selectTask(seed.value.id),
			scope.linkCurrentSession(seed.value.id, 0),
			scope.unlinkSession(seed.value.id, 0, "0".repeat(16)),
		];
		const cases: Array<[string, () => DevelopLaunchWorkspaceV0, string]> = [
			[
				"other directory",
				() => w.service.forLaunch({ projectId: w.projectId, launchDirectory: fresh("elsewhere") }, host),
				"project-mismatch",
			],
			[
				"subdirectory",
				() => {
					const sub = join(w.dir, "sub");
					mkdirSync(sub, { recursive: true });
					return w.service.forLaunch({ projectId: w.projectId, launchDirectory: sub }, host);
				},
				"project-mismatch",
			],
			[
				"unknown project",
				() => w.service.forLaunch({ projectId: `endo.project.${"0".repeat(32)}`, launchDirectory: w.dir }, host),
				"unknown-project",
			],
		];
		for (const [what, open, reason] of cases) {
			const before = fileOf(w.root);
			const scope = open();
			expect([what, scope.view().writable]).toEqual([what, false]);
			for (const result of tryAll(scope))
				expect([what, result]).toEqual([what, { ok: false, code: "read-only", reason }]);
			expect(fileOf(w.root)).toBe(before);
		}
		// The registered directory gone.
		const gone = await registered();
		rmSync(gone.dir, { recursive: true });
		const missing = gone.service.forLaunch({ projectId: gone.projectId, launchDirectory: gone.dir }, host);
		expect(missing.view()).toMatchObject({ readOnlyReason: "project-missing", writable: false });
		expect(missing.createTask({ title: "x" })).toEqual({ ok: false, code: "read-only", reason: "project-missing" });
		// A damaged file is left byte for byte.
		writeFileSync(join(w.root, "develop", "tasks.json"), '{"schemaVersion":"endo.develop-tasks.v9"}\n');
		const damaged = w.service.forLaunch({ projectId: w.projectId, launchDirectory: w.dir }, host);
		expect(damaged.view()).toMatchObject({ state: "unreadable", reason: "unsupported-version" });
		for (const result of tryAll(damaged))
			expect(result).toEqual({ ok: false, code: "read-only", reason: "unreadable" });
		expect(w.service.createTask(w.projectId, { title: "x" })).toEqual({
			ok: false,
			code: "unreadable",
			reason: "unsupported-version",
		});
		expect(fileOf(w.root)).toBe('{"schemaVersion":"endo.develop-tasks.v9"}\n');
	});

	it("builds a reference only from the host's facts; a later launch sees it as historical even for the same session id", async () => {
		const w = await registered();
		const connected = { id: "pi-session-1" as string | null };
		const a = w.service.forLaunch({ projectId: w.projectId, launchDirectory: w.dir }, piHost(LAUNCH_A, connected));
		const task = a.createTask({ title: "Link me" }, { select: true });
		if (!task.ok) throw new Error(task.code);
		const linked = a.linkCurrentSession(task.value.id, task.value.revision);
		expect(linked).toMatchObject({ ok: true, value: { revision: 1 } });
		const stored = new DevelopTasksStoreV0(w.root).read();
		if (!stored.ok) throw new Error(stored.reason);
		expect(stored.file.tasks[0]!.sessions[0]).toMatchObject({
			source: "pi-live",
			sessionId: piEndoSessionIdV0("pi-session-1"),
			attachment: "pi.default",
			launchId: LAUNCH_A,
			linkedBy: "operator",
			via: "workbench",
		});
		expect(a.view().tasks[0]!.sessions[0]!.relation).toBe("current");
		// The session ends: the reference is historical, and the task is exactly as it was (no status, no revision change).
		connected.id = null;
		const ended = a.view().tasks[0]!;
		expect([ended.sessions[0]!.relation, ended.status, ended.revision]).toEqual(["historical", "open", 1]);
		expect(a.linkCurrentSession(task.value.id, 1)).toEqual({ ok: false, code: "no-session" });
		// Reconnecting in a NEW launch with the same Pi session id: still historical.
		connected.id = "pi-session-1";
		const b = w.service.forLaunch({ projectId: w.projectId, launchDirectory: w.dir }, piHost(LAUNCH_B, connected));
		expect(b.view().tasks[0]!.sessions.map((s) => [s.source === "pi-live" ? s.launchId : null, s.relation])).toEqual([
			[LAUNCH_A, "historical"],
		]);
		// And a host of another source reporting that same canonical id cannot make it current, nor record anything. (In v0 the service
		// ignores an unknown source's session altogether; the same-source clause on `current` is for a later version that knows two sources.)
		const before = fileOf(w.root);
		const other = w.service.forLaunch(
			{ projectId: w.projectId, launchDirectory: w.dir },
			{
				launchId: LAUNCH_A,
				attachment: "pi.default",
				session: { source: "codex-live", current: () => ({ sessionId: piEndoSessionIdV0("pi-session-1") }) },
			},
		);
		expect(other.view()).toMatchObject({ linkable: false });
		expect(other.view().tasks[0]!.sessions[0]!.relation).toBe("historical");
		expect(other.linkCurrentSession(task.value.id, 1)).toEqual({ ok: false, code: "unsupported-source" });
		expect(fileOf(w.root)).toBe(before);
	});

	it("refuses a host whose own facts are malformed instead of recording them", async () => {
		const w = await registered();
		const task = w.service.createTask(w.projectId, { title: "x" });
		if (!task.ok) throw new Error(task.code);
		const before = fileOf(w.root);
		for (const host of [
			{ ...piHost("not-a-launch-id", { id: "s" }) },
			{
				launchId: LAUNCH_A,
				attachment: "pi.default",
				session: { source: "pi-live", current: () => ({ sessionId: "raw-id-not-canonical" }) },
			},
		]) {
			const scope = w.service.forLaunch({ projectId: w.projectId, launchDirectory: w.dir }, host);
			expect(scope.linkCurrentSession(task.value.id, 0)).toEqual({ ok: false, code: "unavailable" });
		}
		expect(fileOf(w.root)).toBe(before);
	});
});

describe("the CLI and the workbench write one workspace", () => {
	it("a task made in the workbench is moved by `endo task status` and seen moved by the workbench, and the reverse", async () => {
		const w = await registered();
		const session = new FakeSession();
		const broker = new WorkbenchBrokerV0({
			session,
			key: OTHER_KEY,
			attachment: "pi.default",
			approver: new Approval().approver,
			interventions: new FakeDesk(session),
			tasks: {
				open: (host) =>
					new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(w.root)).forLaunch(
						{ projectId: w.projectId, launchDirectory: w.dir },
						host,
					),
			},
		});
		const call = (method: "GET" | "POST", route: string, body: unknown, grant: string | null) =>
			broker.handle({ method, route: route.split("/"), query: "", grant, body });
		const { code } = broker.issuePairingCode();
		const grant = ((await call("POST", "pair", { code }, null)).body as { grant: string }).grant;
		const created = await call("POST", "workspace/tasks/create", { title: "From the page" }, grant);
		expect(created.status).toBe(200);
		const id = (created.body as EndoDevelopWorkspaceViewV0).selectedTaskId as string;
		const endo = (args: string[]) =>
			spawnSync(process.execPath, [CLI, ...args, "--root", w.root, "--project", w.projectId], {
				encoding: "utf8",
				env: { ...process.env, HOME: base },
			});
		const moved = endo(["task", "status", "--task", id, "--to", "in-progress", "--note", "from the terminal"]);
		expect(moved.status, moved.stderr).toBe(0);
		const seen = (await call("GET", "workspace", null, grant)).body as EndoDevelopWorkspaceViewV0;
		expect(seen.tasks.find((t) => t.id === id)).toMatchObject({ status: "in-progress", revision: 1 });
		// The page's view at revision 0 is now stale: refused, not merged.
		const stale = await call(
			"POST",
			"workspace/tasks/status",
			{ taskId: id, expectedRevision: 0, to: "blocked" },
			grant,
		);
		expect([stale.status, stale.body]).toEqual([409, { error: "stale-revision" }]);
		const added = endo(["task", "add", "--title", "From the terminal"]);
		expect(added.status, added.stderr).toBe(0);
		const fromCli = JSON.parse(added.stdout).task.id as string;
		const ok = await call(
			"POST",
			"workspace/tasks/status",
			{ taskId: fromCli, expectedRevision: 0, to: "in-progress" },
			grant,
		);
		expect(ok.status).toBe(200);
		const listed = endo(["task", "list"]);
		expect(
			JSON.parse(listed.stdout)
				.tasks.map((t: { id: string; status: string }) => [t.id, t.status])
				.sort(),
		).toEqual(
			[
				[id, "in-progress"],
				[fromCli, "in-progress"],
			].sort(),
		);
		// No task operation reached the agent: nothing was prompted, approved or recorded.
		expect(session.promptCalls).toEqual([]);
		expect(session.records).toEqual([]);
		await broker.dispose();
	});
});

describe("writers of both scopes in concurrent processes", () => {
	it("lose no acknowledged write and leave a valid file", async () => {
		const w = await registered();
		const worker = join(REPO, "tests", "fixtures", "develop-workspace-writer.ts");
		const go = join(fresh("go"), "go");
		const children = (["operator", "launch", "operator", "launch", "operator", "launch"] as const).map((scope, n) => {
			const child = spawn(process.execPath, [worker, w.root, w.projectId, w.dir, scope, String(n), "6", go], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (d) => {
				stderr += String(d);
			});
			const ready = new Promise<void>((done, reject) => {
				child.stdout.once("data", () => done());
				child.once("close", () => reject(new Error(`writer ${n} ended before it was ready: ${stderr}`)));
			});
			const closed = new Promise<number | null>((done) => child.once("close", (status) => done(status)));
			return { ready, closed, stderr: () => stderr };
		});
		await Promise.all(children.map((c) => c.ready));
		writeFileSync(go, "");
		const statuses = await Promise.all(children.map((c) => c.closed));
		expect(statuses, children.map((c) => c.stderr()).join("\n")).toEqual([0, 0, 0, 0, 0, 0]);
		const tasks = w.service.tasks(w.projectId);
		if (!tasks.ok) throw new Error(tasks.code);
		expect(tasks.value).toHaveLength(36);
		expect(new Set(tasks.value.map((t) => t.title)).size).toBe(36);
		expect(tasks.value.every((t) => t.status === "in-progress" && t.revision === 1)).toBe(true);
		const file = w.service.read();
		expect(file.ok && file.value.revision).toBe(1 + 36 * 2);
	}, 60_000);
});

describe("a consumer that is not Pi", () => {
	it("opens a project, creates and moves a task, reads it back from another instance, and borrows no session", async () => {
		const w = await registered();
		// A reference recorded earlier by a Pi launch (the parent plays the workbench's host here, with the canonical mapper).
		const pi = w.service.forLaunch(
			{ projectId: w.projectId, launchDirectory: w.dir },
			piHost(LAUNCH_A, { id: "pi-s" }),
		);
		const earlier = pi.createTask({ title: "Linked by Pi" });
		if (!earlier.ok) throw new Error(earlier.code);
		expect(pi.linkCurrentSession(earlier.value.id, 0).ok).toBe(true);
		const consumer = join(REPO, "tests", "fixtures", "develop-workspace-consumer.ts");
		const run = spawnSync(process.execPath, [consumer, w.root, w.projectId, w.dir], {
			encoding: "utf8",
			env: { ...process.env, BORROW_SESSION_ID: piEndoSessionIdV0("pi-s") },
		});
		expect(run.status, run.stderr).toBe(0);
		const out = JSON.parse(run.stdout);
		expect(out.opened).toEqual({ state: "ready", writable: true, linkable: false, project: w.projectId });
		expect(out.before).toEqual([earlier.value.id]);
		expect(out.moves).toEqual(["in-progress", "review", "done"]);
		expect([out.skip, out.stale, out.link, out.borrowed]).toEqual([
			"invalid-transition",
			"stale-revision",
			"no-session",
			"unsupported-source",
		]);
		expect(out.borrowingView).toEqual(["historical"]);
		expect(out.readBack).toEqual({ status: "done", revision: 3, history: 4 });
		expect(out.references).toEqual([
			{ task: earlier.value.id, source: "pi-live", launchId: LAUNCH_A, relation: "historical" },
		]);
		// The consumer recorded no reference of its own.
		const stored = new DevelopTasksStoreV0(w.root).read();
		if (!stored.ok) throw new Error(stored.reason);
		expect(
			stored.file.tasks.flatMap((t) => t.sessions).map((s) => (s.source === "pi-live" ? s.launchId : null)),
		).toEqual([LAUNCH_A]);
	});

	it("neither the service nor that consumer reaches a harness adapter, a server or the page", () => {
		const seen = new Set<string>();
		const walk = (file: string): void => {
			if (seen.has(file)) return;
			seen.add(file);
			const source = readFileSync(file, "utf8");
			// Every static form (`import x from`, `export … from`, a bare `import "…"`) and a dynamic `import("…")`.
			for (const m of source.matchAll(
				/(?:^\s*(?:import|export)\s(?:[^;"']*?\sfrom\s+)?|\bimport\(\s*)["'](\.{1,2}\/[^"']+)["']/gm,
			))
				walk(resolve(dirname(file), m[1]!));
		};
		walk(join(REPO, "runtime", "contracts", "develop-workspace.ts"));
		walk(join(REPO, "tests", "fixtures", "develop-workspace-consumer.ts"));
		const reached = [...seen].map((f) => f.slice(REPO.length + 1));
		expect(reached).toContain("storage/develop-tasks.ts");
		const forbidden = reached.filter((f) => /^(adapters\/|cockpit-http\/|cockpit\/|studio-ui\/|cli\/)/.test(f));
		expect(forbidden).toEqual([]);
		// And nothing it reaches opens a socket, spawns a process or fetches (Git's observation at registration is the caller's own).
		const own = reached.map((f) => readFileSync(join(REPO, f), "utf8")).join("\n");
		// A scope is opened only through a service object.
		expect(() => Reflect.construct(DevelopLaunchWorkspaceV0, [Symbol("forged"), null, {}, {}])).toThrow(TypeError);
		expect(own).not.toMatch(/node:(child_process|net|http|https|dgram|worker_threads)|\bfetch\(/);
	});
});
