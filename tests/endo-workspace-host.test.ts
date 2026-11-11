// The workspace host (cockpit-http/workspace-host.ts, docs/designs/workspace-host.md) over the real cockpit server, the real task, attempt
// and receipt stores and a real Git repository: no Pi, no fake session, no broker. What it must do (pair, read the project's work, change
// a task by the store's rules) and what it must never do (read without the grant, answer after a revocation, reach an agent route, name a
// path, link a session, write on a read), plus the static import closure of `endo workspace open`.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { endoDevelopServiceV0, endoReceiptCurrentV0 } from "../cli/develop-service.ts";
import { EndoWorkspaceHostV0 } from "../cockpit-http/workspace-host.ts";
import type { EndoReceiptCurrentV0 } from "../protocol/develop-receipts.ts";
import type { EndoWorkbenchProjectV0 } from "../protocol/workbench-project.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import type { EndoProjectSourceV0 } from "../runtime/contracts/workspace-routes.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { capabilityOf, type Reply, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { seedAttention, taskIn } from "./studio-attention-fixtures.ts";

afterEach(async () => {
	await stopServers();
	cleanGitFixtures();
});
afterAll(() => removeTempRoots((r) => rmSync(r, { recursive: true, force: true })));

const suite = haveGit ? describe : describe.skip;

function register(root: string, cwd: string): string {
	const made = new DevelopTasksStoreV0(root).registerProject({
		name: "Parser work",
		path: realpathSync(cwd),
		observedGitRoot: realpathSync(cwd),
	});
	if (!made.ok) throw new Error(`registration refused: ${made.code}`);
	return made.value.id;
}

interface Opened {
	root: string;
	cwd: string;
	projectId: string;
	host: EndoWorkspaceHostV0;
	/** The fixture's attempts by role (seedAttention), when seeded. */
	attempts: Record<string, string>;
	server: Awaited<ReturnType<typeof serve>>;
	clock: { now: number };
	call(
		route: string,
		init?: { method?: "GET" | "POST"; body?: unknown; grant?: string | null; headers?: Record<string, string> },
	): Promise<Reply>;
	pair(): Promise<string>;
}

/** A host as `endo workspace open` builds it (cli/develop-service.ts), with a clock and, optionally, a held Git observation or project source. */
async function open(
	options: {
		seed?: boolean;
		current?: (directory: string) => Promise<EndoReceiptCurrentV0 | null>;
		project?: EndoProjectSourceV0;
	} = {},
): Promise<Opened> {
	const root = tempRoot("endo-workspace-host-");
	const cwd = demoRepo();
	const projectId = register(root, cwd);
	let attempts: Record<string, string> = {};
	if (options.seed !== false) {
		const current = await endoReceiptCurrentV0(cwd);
		if (current === null) throw new Error("the demo repository cannot be observed");
		attempts = seedAttention(root, projectId, current).attempts;
	}
	const clock = { now: Date.now() };
	const service =
		options.current === undefined
			? endoDevelopServiceV0(root)
			: new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root), {
					attempts: new DevelopAttemptsStoreV0(root),
					receipts: { store: new DevelopReceiptsStoreV0(root), current: options.current },
				});
	const host = new EndoWorkspaceHostV0({
		open: (facts) => service.forLaunch({ projectId, launchDirectory: cwd }, facts),
		project: options.project ?? new GitProjectInspectorV0({ cwd, minRefreshMs: 0 }),
		now: () => clock.now,
	});
	const server = await serve(root, { workbench: host, readBudget: { duty: 1, burstMs: 1e6 } });
	const origin = `http://127.0.0.1:${server.port}`;
	let held: string | null = null;
	const call: Opened["call"] = (route, init = {}) => {
		const method = init.method ?? (init.body === undefined ? "GET" : "POST");
		const body = init.body === undefined ? undefined : JSON.stringify(init.body);
		const grant = init.grant === undefined ? held : init.grant;
		return send(server, `${capabilityOf(server)}/api/v0/workbench/${route}`, {
			method,
			headers: {
				...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}),
				...(body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) }),
				...(grant === null ? {} : { "X-Endo-Grant": grant }),
				...init.headers,
			},
			...(body === undefined ? {} : { body }),
		});
	};
	const pair = async () => {
		const reply = await call("pair", { body: { code: host.issuePairingCode().code }, grant: null });
		expect(reply.status).toBe(200);
		held = (JSON.parse(reply.body) as { grant: string }).grant;
		return held;
	};
	return { root, cwd, projectId, host, attempts, server, clock, call, pair };
}

const json = <T = Record<string, unknown>>(reply: Reply): T => JSON.parse(reply.body) as T;
const taskFile = (root: string) =>
	JSON.parse(readFileSync(join(root, "develop", "tasks.json"), "utf8")) as {
		revision: number;
		tasks: { id: string; title: string; status: string; revision: number; sessions: unknown[]; history: unknown[] }[];
	};
/** Every byte under develop/: a read must leave it exactly as it was. */
function developDigest(root: string): string {
	const hash = createHash("sha256");
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			const s = statSync(p);
			hash.update(`${relative(root, p)}:${s.mtimeMs}\n`);
			if (s.isDirectory()) walk(p);
			else hash.update(readFileSync(p));
		}
	};
	walk(join(root, "develop"));
	return hash.digest("hex");
}
const gate = () => {
	let release!: () => void;
	const held = new Promise<void>((r) => {
		release = r;
	});
	return { held, release };
};

suite("the workspace host: reads and changes the project's work with no agent", () => {
	it("says what it is without a grant, and nothing else: harness null, no session, no task text", async () => {
		const w = await open();
		const status = await w.call("status", { grant: null });
		expect(status.status).toBe(200);
		expect(json(status)).toEqual({
			schemaVersion: "endo.workspace-host-status.v0",
			launchId: w.host.launchId,
			host: "workspace",
			harness: null,
			paired: false,
			changes: true,
		});
		for (const route of ["workspace", "workspace/attention", "workspace/attempts", "project"]) {
			const reply = await w.call(route, { grant: null });
			expect([route, reply.status, json(reply)]).toEqual([route, 401, { error: "grant-required" }]);
			expect(reply.body).not.toContain("Stream the parser");
		}
		const refused = await w.call("workspace/tasks/create", { body: { title: "Not allowed" }, grant: null });
		expect(refused.status).toBe(401);
		expect(taskFile(w.root).tasks.some((t) => t.title === "Not allowed")).toBe(false);
	});

	it("pairs once per code, refuses every wrong one alike, and discards a code after five wrong tries", async () => {
		const w = await open({ seed: false });
		const { code } = w.host.issuePairingCode();
		for (const wrong of ["AAAA-AAAA", 7, "", "x".repeat(17)]) {
			const reply = await w.call("pair", { body: { code: wrong }, grant: null });
			expect([reply.status, json(reply)]).toEqual([401, { error: "pairing-refused" }]);
		}
		expect((await w.call("pair", { body: { code: "BBBB-BBBB" }, grant: null })).status).toBe(401);
		// Five wrong tries: the right code no longer pairs.
		expect((await w.call("pair", { body: { code }, grant: null })).status).toBe(401);
		const fresh = w.host.issuePairingCode().code;
		const paired = await w.call("pair", { body: { code: fresh.toLowerCase() }, grant: null });
		expect(paired.status).toBe(200);
		expect(json(paired)).toMatchObject({ schemaVersion: "endo.workbench-grant.v0" });
		// Single use.
		expect((await w.call("pair", { body: { code: fresh }, grant: null })).status).toBe(401);
		expect(json(await w.call("status", { grant: null }))).toMatchObject({ paired: true });
	});

	it("serves the project, the attention overview, the selected task's attempts and the worktree to the paired page, and writes nothing", async () => {
		const w = await open();
		await w.pair();
		const before = developDigest(w.root);
		const view = json<{ state: string; writable: boolean; linkable: boolean; tasks: { title: string }[] }>(
			await w.call("workspace"),
		);
		expect(view).toMatchObject({ state: "ready", writable: true, linkable: false });
		expect(view.tasks.map((t) => t.title)).toContain("Normalize CRLF line endings");
		const attention = json<{
			state: string;
			head: { commit: string } | null;
			tasks: {
				checks: { outcome: string; relation: string; command: string }[];
				planned: { state: string; receipt: { outcome: string } | null }[];
			}[];
		}>(await w.call("workspace/attention"));
		expect(attention.state).toBe("ready");
		expect(attention.head).not.toBeNull();
		const checks = attention.tasks.flatMap((t) => t.checks);
		// v1: the CRLF task has a plan, so its receipts are read by its own ledger under `planned` (its latest run at HEAD failed).
		const planned = attention.tasks.flatMap((t) => t.planned);
		expect([...checks.map((c) => c.outcome), ...planned.flatMap((p) => p.receipt?.outcome ?? [])]).toEqual(
			expect.arrayContaining(["failed", "inconclusive", "passed"]),
		);
		// Revision-aware, unchanged: the stale pass is at another commit; the other worktree's check is not compared as local.
		expect(checks.map((c) => c.relation)).toEqual(
			expect.arrayContaining(["head-differs", "at-head-changed", "other-worktree"]),
		);
		const attempts = await w.call("workspace/attempts");
		expect(attempts.status).toBe(200);
		const project = json<{ state: string }>(await w.call("project"));
		expect(project.state).toBe("ready");
		expect(developDigest(w.root)).toBe(before);
	});

	it("changes a status by the store's rules: the revision it saw, the allowed moves, the note, exactly one write", async () => {
		const w = await open();
		await w.pair();
		const target = taskFile(w.root).tasks.find((t) => t.title === "Document the streaming API")!;
		const moved = await w.call("workspace/tasks/status", {
			body: {
				taskId: target.id,
				expectedRevision: target.revision,
				to: "in-progress",
				note: "picked up without an agent",
			},
		});
		expect(moved.status).toBe(200);
		const after = taskFile(w.root).tasks.find((t) => t.id === target.id)!;
		expect([after.status, after.revision, after.history.length]).toEqual(["in-progress", target.revision + 1, 2]);
		// The same revision again is stale; the file is not touched.
		const stale = await w.call("workspace/tasks/status", {
			body: { taskId: target.id, expectedRevision: target.revision, to: "review" },
		});
		expect([stale.status, json(stale)]).toEqual([409, { error: "stale-revision" }]);
		const invalid = await w.call("workspace/tasks/status", {
			body: { taskId: target.id, expectedRevision: after.revision, to: "nonsense" },
		});
		expect(invalid.status).toBe(400);
		expect(taskFile(w.root).tasks.find((t) => t.id === target.id)).toEqual(after);
	});

	it("loses no update when two changes race on one revision: one wins, the other is told it was stale", async () => {
		const w = await open({ seed: false });
		const id = taskIn(w.root, w.projectId, "Race", "open");
		await w.pair();
		const seen = taskFile(w.root).tasks.find((t) => t.id === id)!;
		const [a, b] = await Promise.all([
			w.call("workspace/tasks/update", { body: { taskId: id, expectedRevision: seen.revision, title: "Race A" } }),
			w.call("workspace/tasks/update", { body: { taskId: id, expectedRevision: seen.revision, title: "Race B" } }),
		]);
		expect([a.status, b.status].sort()).toEqual([200, 409]);
		const now = taskFile(w.root).tasks.find((t) => t.id === id)!;
		expect(now.revision).toBe(seen.revision + 1);
		expect(now.title).toBe(a.status === 200 ? "Race A" : "Race B");
	});

	it("sees what the CLI's own store wrote, at once, and the CLI sees what the page wrote", async () => {
		const w = await open({ seed: false });
		await w.pair();
		// The operator's terminal (the same service `endo task add` uses) adds a task while the host runs.
		const made = endoDevelopServiceV0(w.root).createTask(w.projectId, { title: "Added from the terminal" });
		expect(made.ok).toBe(true);
		const view = json<{ tasks: { title: string }[] }>(await w.call("workspace"));
		expect(view.tasks.map((t) => t.title)).toContain("Added from the terminal");
		const created = await w.call("workspace/tasks/create", { body: { title: "Added from the page" } });
		expect(created.status).toBe(200);
		const listed = endoDevelopServiceV0(w.root).tasks(w.projectId);
		expect(listed.ok && listed.value.map((t) => t.title)).toContain("Added from the page");
	});

	it("has no agent route, links no session, and names no path: those requests are refused and write nothing", async () => {
		const w = await open();
		await w.pair();
		const before = readFileSync(join(w.root, "develop", "tasks.json"));
		for (const [route, body] of [
			["transcript", undefined],
			["prompt/propose", { message: "run the tests" }],
			// Sending a work attempt is the live workbench terminal's request only (docs/designs/develop-attempt-execution.md).
			["prompt/propose", { attemptId: "endo.attempt.0123456789abcdef0123456789abcdef" }],
			["attempt/propose", { attemptId: "endo.attempt.0123456789abcdef0123456789abcdef" }],
			["workspace/attempts/send", { attemptId: "endo.attempt.0123456789abcdef0123456789abcdef" }],
			["workspace/attempts", { attemptId: "endo.attempt.0123456789abcdef0123456789abcdef" }],
			["prompt/discard", { proposalId: "x" }],
			["intervention/propose", { operation: "stop" }],
			["intervention/check", { proposalId: "x" }],
			["intervention/x", undefined],
			["workspace/sessions", undefined],
			["project/diff/../../etc", undefined],
		] as const) {
			const reply = await w.call(route, body === undefined ? {} : { body });
			expect([route, reply.status]).toEqual([route, 404]);
		}
		const task = taskFile(w.root).tasks[0]!;
		const link = await w.call("workspace/tasks/link-session", {
			body: { taskId: task.id, expectedRevision: task.revision },
		});
		expect([link.status, json(link)]).toEqual([409, { error: "no-session" }]);
		// A request that tries to describe a session, a project or a path is refused by shape before anything is read.
		for (const body of [
			{ taskId: task.id, expectedRevision: task.revision, sessionId: "endo.session.pi.x" },
			{ taskId: task.id, expectedRevision: task.revision, launchId: "0".repeat(16) },
		]) {
			const reply = await w.call("workspace/tasks/link-session", { body });
			expect(reply.status).toBe(400);
		}
		const scoped = await w.call("workspace/tasks/create", { body: { title: "Elsewhere", projectId: "other" } });
		expect(scoped.status).toBe(400);
		expect((await w.call("workspace?root=/etc")).status).toBe(400);
		expect((await w.call("workspace/attention?project=other")).status).toBe(400);
		expect(readFileSync(join(w.root, "develop", "tasks.json"))).toEqual(before);
	});

	it("ends a grant when it expires, when the terminal revokes it, when a new pairing replaces it, and when the host stops", async () => {
		const w = await open({ seed: false });
		const first = await w.pair();
		expect((await w.call("workspace")).status).toBe(200);
		// Replaced: a second pairing; the first page can no longer read or write.
		const second = await w.pair();
		expect((await w.call("workspace", { grant: first })).status).toBe(401);
		expect((await w.call("workspace/tasks/create", { body: { title: "old grant" }, grant: first })).status).toBe(401);
		expect((await w.call("workspace", { grant: second })).status).toBe(200);
		// Revoked from the terminal.
		w.host.revoke();
		expect((await w.call("workspace", { grant: second })).status).toBe(401);
		expect(json(await w.call("status", { grant: null }))).toMatchObject({ paired: false });
		// Expired: an hour later.
		const third = await w.pair();
		w.clock.now += 60 * 60_000;
		expect((await w.call("workspace", { grant: third })).status).toBe(401);
		// A code expires too (ten minutes).
		const { code } = w.host.issuePairingCode();
		w.clock.now += 10 * 60_000;
		expect((await w.call("pair", { body: { code }, grant: null })).status).toBe(401);
		// Stopped: nothing pairs or reads any more.
		const fourth = await w.pair();
		w.host.close();
		expect((await w.call("workspace", { grant: fourth })).status).toBe(401);
		expect((await w.call("pair", { body: { code: w.host.issuePairingCode().code }, grant: null })).status).toBe(401);
		expect(taskFile(w.root).tasks.some((t) => t.title === "old grant")).toBe(false);
	});

	it("never answers a read that outlived its grant: revoked while Git was being read, the reply is the refusal", async () => {
		let g = gate();
		const w = await open({
			current: async (directory) => {
				await g.held;
				return endoReceiptCurrentV0(directory);
			},
		});
		await w.pair();
		// A task with attempts, chosen: the attempts read compares its receipts with HEAD (the held observation).
		const chosen = taskFile(w.root).tasks.find((t) => t.title === "Normalize CRLF line endings")!;
		expect((await w.call("workspace/tasks/select", { body: { taskId: chosen.id } })).status).toBe(200);
		for (const route of ["workspace/attention", "workspace/attempts"]) {
			g = gate();
			const pending = w.call(route);
			await new Promise((r) => setTimeout(r, 50));
			w.host.revoke();
			g.release();
			const reply = await pending;
			expect([route, reply.status, json(reply)]).toEqual([route, 401, { error: "grant-required" }]);
			expect(reply.body).not.toContain("Stream the parser");
			await w.pair();
		}
	});

	it("never answers a worktree read that outlived its grant", async () => {
		const g = gate();
		const project: EndoProjectSourceV0 = {
			overview: async () => {
				await g.held;
				return { state: "ready", secret: "the worktree" } as unknown as EndoWorkbenchProjectV0;
			},
			diff: async () => ({ kind: "busy" }),
		};
		const w = await open({ seed: false, project });
		await w.pair();
		const pending = w.call("project");
		await new Promise((r) => setTimeout(r, 50));
		w.host.revoke();
		g.release();
		const reply = await pending;
		expect([reply.status, json(reply)]).toEqual([401, { error: "grant-required" }]);
	});

	it("refuses rebinding, cross-origin and malformed requests before the host sees them", async () => {
		const w = await open({ seed: false });
		const grant = await w.pair();
		const before = readFileSync(join(w.root, "develop", "tasks.json"));
		const body = JSON.stringify({ title: "smuggled" });
		const target = `${capabilityOf(w.server)}/api/v0/workbench/workspace/tasks/create`;
		const origin = `http://127.0.0.1:${w.server.port}`;
		const post = (headers: Record<string, string>, text = body) =>
			send(w.server, target, {
				method: "POST",
				headers: { "Content-Length": String(Buffer.byteLength(text)), "X-Endo-Grant": grant, ...headers },
				body: text,
			});
		expect(
			(await post({ Host: `evil.example:${w.server.port}`, Origin: origin, "Content-Type": "application/json" }))
				.status,
		).toBe(421);
		expect((await post({ Origin: "http://evil.example", "Content-Type": "application/json" })).status).toBe(403);
		expect(
			(await post({ Origin: origin, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" })).status,
		).toBe(403);
		expect((await post({ "Content-Type": "application/json" })).status).toBe(403);
		expect((await post({ Origin: origin, "Content-Type": "text/plain" })).status).toBe(400);
		expect((await post({ Origin: origin, "Content-Type": "application/json" }, "{not json")).status).toBe(400);
		expect(
			(
				await post(
					{ Origin: origin, "Content-Type": "application/json" },
					JSON.stringify({ title: "x".repeat(50_000) }),
				)
			).status,
		).toBe(400);
		expect(
			(await post({ Origin: origin, "Content-Type": "application/json" }, JSON.stringify({ title: "ok", extra: 1 })))
				.status,
		).toBe(400);
		const read = await send(w.server, `${capabilityOf(w.server)}/api/v0/workbench/workspace`, {
			headers: { "X-Endo-Grant": grant, Origin: "http://evil.example" },
		});
		expect(read.status).toBe(403);
		// No CORS header is ever sent.
		expect(read.headers["access-control-allow-origin"]).toBeUndefined();
		// A wrong capability path is not found, with a grant or without.
		const wrong = await send(w.server, "/not-the-capability/api/v0/workbench/workspace", {
			headers: { "X-Endo-Grant": grant },
		});
		expect(wrong.status).toBe(404);
		expect(readFileSync(join(w.root, "develop", "tasks.json"))).toEqual(before);
	});

	it("shows evidence it could not read as a limitation, never as an empty or passing read", async () => {
		const w = await open();
		await w.pair();
		// The receipts of an OPEN task's attempt (a done task's receipts are not read at all, by design): named, never "the first directory".
		const attempt = w.attempts.regressed!;
		writeFileSync(join(w.root, "develop", "receipts", attempt, "torn.json"), "{ not a receipt");
		const attention = json<{ tasks: { taskId: string; problems: number; checks: unknown[]; planned: unknown[] }[] }>(
			await w.call("workspace/attention"),
		);
		const regressed = attention.tasks.find((t) => t.problems > 0);
		expect(regressed?.problems).toBe(1);
		// The usable receipts beside it are still read: a torn file is counted, not taken as "no checks".
		expect((regressed?.checks.length ?? 0) + (regressed?.planned.length ?? 0)).toBeGreaterThan(0);
		// The task file damaged: an explicit unreadable state, not an empty project.
		writeFileSync(join(w.root, "develop", "tasks.json"), "{ torn");
		const view = json<{ state: string; reason: string; tasks: unknown[] }>(await w.call("workspace"));
		expect(view).toMatchObject({ state: "unreadable", reason: "malformed", tasks: [] });
		expect(json(await w.call("workspace/attention"))).toMatchObject({ state: "unreadable" });
		const write = await w.call("workspace/tasks/create", { body: { title: "into a torn file" } });
		expect([write.status, json(write)]).toEqual([409, { error: "read-only", reason: "unreadable" }]);
		expect(readFileSync(join(w.root, "develop", "tasks.json"), "utf8")).toBe("{ torn");
	});
});

describe("endo studio keeps no writable workspace", () => {
	it("answers the workbench status with its constant and refuses every workspace route and POST", async () => {
		const root = tempRoot("endo-studio-readonly-");
		const server = await serve(root);
		const base = `${capabilityOf(server)}/api/v0/workbench`;
		const status = await send(server, `${base}/status`);
		expect([status.status, JSON.parse(status.body)]).toEqual([
			200,
			{ available: false, schemaVersion: "endo.workbench-status.v0" },
		]);
		for (const route of ["workspace", "workspace/attention", "workspace/attempts", "project", "pair"])
			expect((await send(server, `${base}/${route}`)).status).toBe(404);
		const body = JSON.stringify({ title: "x" });
		const post = await send(server, `${base}/workspace/tasks/create`, {
			method: "POST",
			headers: {
				Origin: `http://127.0.0.1:${server.port}`,
				"Content-Type": "application/json",
				"Content-Length": String(body.length),
			},
			body,
		});
		expect(post.status).toBe(405);
		expect(existsSync(join(root, "develop"))).toBe(false);
	});
});

describe("harness neutrality of `endo workspace open`", () => {
	/** The static import closure of a module (relative imports, including dynamic `import("…")`, excluding `import type`). */
	function closure(entries: string[]): Set<string> {
		const root = resolve(import.meta.dirname, "..");
		const seen = new Set<string>();
		const stack = entries.map((e) => resolve(root, e));
		const statics = /(?:^|\n)\s*(import|export)(\s+type)?\s[^"';]*?from\s+["']([^"']+)["']/g;
		const sideEffects = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
		const dynamic = /import\(\s*["']([^"']+)["']\s*\)/g;
		while (stack.length > 0) {
			const file = stack.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			const source = readFileSync(file, "utf8");
			const specs = [
				...[...source.matchAll(statics)].filter((m) => m[2] === undefined).map((m) => m[3]!),
				...[...source.matchAll(sideEffects)].map((m) => m[1]!),
				...[...source.matchAll(dynamic)].map((m) => m[1]!),
			];
			for (const spec of specs) {
				if (!spec.startsWith(".")) continue;
				const target = resolve(dirname(file), spec);
				// An import that does not resolve would hide a whole subtree from this check: it fails instead.
				if (!existsSync(target)) throw new Error(`${relative(root, file)}: unresolved import ${spec}`);
				stack.push(target);
			}
		}
		return new Set([...seen].map((f) => relative(root, f)));
	}

	it("reaches no harness control: no Pi attachment, RPC, broker, interventions or live transcript, and no harness CLI", () => {
		const reached = closure(["cli/workspace.ts"]);
		expect(reached.has("cockpit-http/workspace-host.ts")).toBe(true);
		const pi = [...reached].filter((f) => f.startsWith("adapters/pi/")).sort();
		// Only the recorded-evidence projections the read-only `endo studio` already loads (the recorded session list and comparisons).
		expect(pi).toEqual(["adapters/pi/lifecycle.ts", "adapters/pi/mapping.ts", "adapters/pi/trajectory.ts"]);
		const studio = closure(["cli/studio.ts", "cockpit-http/host.ts"]);
		for (const f of pi) expect(studio.has(f)).toBe(true);
		// OMP: only its read-only saved-session observer, reached through Studio's own module (never run by this command).
		for (const f of reached.values()) if (f.startsWith("adapters/omp/")) expect(studio.has(f)).toBe(true);
		// An allow-list of adapter directories: Git (read-only observation), the recorded-evidence projections Studio reads (Pi, DSH), and
		// OMP's read-only saved-session observer. A new adapter (a harness, a provider, a proxy) in this closure fails here.
		const adapters = new Set([...reached].filter((f) => f.startsWith("adapters/")).map((f) => f.split("/")[1]));
		expect([...adapters].filter((d) => !["git", "pi", "dsh-native", "omp"].includes(d!))).toEqual([]);
		for (const f of reached) {
			expect(f).not.toMatch(/^adapters\/(rpc-jsonl|acp)\//);
			expect(f).not.toMatch(/^cli\/(harness|workbench|steer|experiment|replay)\.ts$/);
			expect(f).not.toMatch(/^research\//);
		}
		// Neither this host nor Studio can write an attempt's send authorisation: the module that does is the live workbench's alone.
		expect(reached.has("runtime/contracts/develop-attempt-dispatch.ts")).toBe(false);
		expect(studio.has("runtime/contracts/develop-attempt-dispatch.ts")).toBe(false);
		expect(closure(["cli/workbench.ts"]).has("runtime/contracts/develop-attempt-dispatch.ts")).toBe(true);
		// And the host module itself imports nothing from any adapter.
		expect([...closure(["cockpit-http/workspace-host.ts"])].filter((f) => f.startsWith("adapters/"))).toEqual([]);
	});

	it("constructs no Pi attachment and spawns nothing: the host and its command name no harness executable", () => {
		for (const file of [
			"cockpit-http/workspace-host.ts",
			"runtime/contracts/workspace-routes.ts",
			"runtime/contracts/workbench-pairing.ts",
			"cli/workspace.ts",
		]) {
			const source = readFileSync(resolve(import.meta.dirname, "..", file), "utf8");
			expect([file, /PiSessionAttachment|WorkbenchBroker|child_process|spawn\(|execFile/.test(source)]).toEqual([
				file,
				false,
			]);
		}
	});
});
