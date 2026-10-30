// The project routes of the workbench over its real HTTP surface, with a real repository: they are GETs behind the grant, they take no
// path or command from the page, they are narrow about their query, a workbench without a project context says so quietly, the plain
// read-only Studio has none, and nothing they read reaches canonical evidence. Also: the browser's wire gate and the project model.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import {
	ENDO_DIFF_REASONS_V0,
	ENDO_PROJECT_INCOMPLETE_V0,
	ENDO_PROJECT_REASONS_V0,
	type EndoWorkbenchDiffV0,
	type EndoWorkbenchProjectV0,
} from "../protocol/workbench-project.ts";
import { event, ingestAll, removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { capabilityOf, get, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { cleanGitFixtures, demoRepo, haveGit, write } from "./git-fixtures.ts";
import { Approval, FakeSession } from "./workbench-fixtures.ts";

afterEach(async () => {
	await stopServers();
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
	cleanGitFixtures();
});
const suite = haveGit ? describe : describe.skip;

const API = "/api/v0/workbench/";

async function start(options: { project?: GitProjectInspectorV0 | null } = {}) {
	const session = new FakeSession();
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: new Approval().approver,
		...(options.project === null || options.project === undefined ? {} : { project: options.project }),
	});
	const root = tempRoot("endo-wb-project-");
	ingestAll(root, [
		event("harness.attached", {}, { session: "endo.session.pi.x", producer: "pi-rpc-adapter:pi.default" }),
	]);
	const server = await serve(root, { workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	const post = (route: string, body: unknown) =>
		send(server, `${capabilityOf(server)}${API}${route}`, {
			method: "POST",
			headers: { Origin: server.origin, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const pair = async (): Promise<string> => {
		const reply = await post("pair", { code: broker.issuePairingCode().code });
		return (JSON.parse(reply.body) as { grant: string }).grant;
	};
	const getW = (route: string, grant?: string) =>
		get(server, `${API}${route}`, grant === undefined ? {} : { "X-Endo-Grant": grant });
	return { session, broker, root, server, post, pair, getW };
}
const json = <T>(reply: { body: string }): T => JSON.parse(reply.body) as T;

suite("the project routes", () => {
	it("serve the launch directory's worktree and one file's diff, only to a paired page", async () => {
		const repo = demoRepo();
		const { pair, getW } = await start({ project: new GitProjectInspectorV0({ cwd: repo, minRefreshMs: 0 }) });
		// No grant: nothing about the worktree, not even its existence.
		expect((await getW("project")).status).toBe(401);
		expect((await getW("project/diff?snapshot=0123456789abcdef&file=0")).status).toBe(401);
		const grant = await pair();
		const reply = await getW("project", grant);
		expect(reply.status).toBe(200);
		const project = json<EndoWorkbenchProjectV0>(reply);
		expect(project).toMatchObject({
			schemaVersion: "endo.workbench-project.v0",
			basis: "launch-directory",
			state: "ready",
		});
		expect(project.repository?.root).toBe(repo);
		const entry = project.changes.files.find((f) => f.path.endsWith("tokenizer.ts") && f.area === "unstaged");
		expect(entry).toBeDefined();
		const diff = await getW(`project/diff?snapshot=${project.snapshot}&file=${entry?.id}`, grant);
		expect(diff.status).toBe(200);
		const record = json<EndoWorkbenchDiffV0>(diff);
		expect(record).toMatchObject({
			comparison: "index-to-working-tree",
			state: "ready",
			snapshot: project.snapshot,
			id: entry?.id,
		});
		expect(record.hunks.flatMap((h) => h.lines).some((l) => l.includes("tokenizeStream"))).toBe(true);
	});

	it("are narrow: a fixed query shape, GET only, and a path or any other argument is refused", async () => {
		const repo = demoRepo();
		const { pair, getW, post, server } = await start({
			project: new GitProjectInspectorV0({ cwd: repo, minRefreshMs: 0 }),
		});
		const grant = await pair();
		const project = json<EndoWorkbenchProjectV0>(await getW("project", grant));
		const snap = project.snapshot;
		for (const query of [
			`project/diff?snapshot=${snap}&file=-1`,
			`project/diff?snapshot=${snap}&file=01`,
			`project/diff?snapshot=${snap}&file=1&path=/etc/passwd`,
			`project/diff?file=1&snapshot=${snap}`,
			`project/diff?snapshot=${snap.toUpperCase()}&file=1`,
			`project/diff?snapshot=../../etc&file=1`,
			`project/diff?snapshot=${snap}&file=9999999`,
			"project/diff",
		])
			expect((await getW(query, grant)).status, query).toBe(400);
		// The overview takes no argument at all: a query on it matches no route.
		for (const query of ["project?path=/etc", "project?cwd=/", "project?x"])
			expect((await getW(query, grant)).status, query).toBe(404);
		// Nothing else under project exists, and nothing can be sent to it.
		expect((await getW("project/other", grant)).status).toBe(404);
		expect((await getW("project/diff/x", grant)).status).toBe(404);
		expect((await post("project", { cwd: "/" })).status).not.toBe(200);
		expect((await post("project/diff", { path: "/etc/passwd" })).status).not.toBe(200);
		// A command surface is still only the ones it had: no git command, shell or path route was added.
		for (const route of ["git", "git/status", "shell", "exec", "fs", "file", "open", "checkout", "stage", "commit"])
			expect((await getW(route, grant)).status, route).toBe(404);
		void server;
	});

	it("refuse a diff once the working tree has moved on, with a fixed refusal and no text of the file", async () => {
		const repo = demoRepo();
		const { pair, getW } = await start({ project: new GitProjectInspectorV0({ cwd: repo, minRefreshMs: 0 }) });
		const grant = await pair();
		const project = json<EndoWorkbenchProjectV0>(await getW("project", grant));
		const entry = project.changes.files.find((f) => f.path.endsWith("stream.ts") && f.area === "untracked");
		writeFileSync(join(repo, "src/parser/stream.ts"), "export const SECRET_EDIT = 1;\n// a different length\n");
		const stale = await getW(`project/diff?snapshot=${project.snapshot}&file=${entry?.id}`, grant);
		expect(stale.status).toBe(409);
		expect(json<{ error: string }>(stale)).toEqual({ error: "stale-snapshot" });
		expect(stale.body).not.toContain("SECRET_EDIT");
		// An older snapshot is stale as well, even for an entry that is unchanged.
		const fresh = json<EndoWorkbenchProjectV0>(await getW("project", grant));
		expect(fresh.snapshot).not.toBe(project.snapshot);
		expect((await getW(`project/diff?snapshot=${project.snapshot}&file=0`, grant)).status).toBe(409);
	});

	it("say so quietly when the workbench was started without a project context, and are absent on the read-only server", async () => {
		const bare = await start();
		const grant = await bare.pair();
		const reply = await bare.getW("project", grant);
		expect(reply.status).toBe(200);
		expect(json(reply)).toEqual({ available: false, schemaVersion: "endo.workbench-project.v0" });
		expect((await bare.getW("project/diff?snapshot=0123456789abcdef&file=0", grant)).status).toBe(404);

		const root = tempRoot("endo-wb-ro-project-");
		ingestAll(root, [
			event("harness.attached", {}, { session: "endo.session.pi.x", producer: "pi-rpc-adapter:pi.default" }),
		]);
		const readOnly = await serve(root, {});
		for (const route of ["project", "project/diff?snapshot=0123456789abcdef&file=0"])
			expect((await get(readOnly, `${API}${route}`)).status, route).toBe(404);
	});

	it("answer 429 busy for an overview that could not run, and never serve 'busy' as if it were a worktree", async () => {
		const repo = demoRepo();
		const inner = new GitProjectInspectorV0({ cwd: repo, minRefreshMs: 0 });
		const busy = {
			...(await inner.overview()),
			state: "unavailable" as const,
			reason: "busy" as const,
			repository: null,
		};
		const { pair, getW } = await start({
			project: {
				overview: async () => busy,
				diff: async () => ({ kind: "busy" as const }),
			} as unknown as GitProjectInspectorV0,
		});
		const grant = await pair();
		const reply = await getW("project", grant);
		expect(reply.status).toBe(429);
		expect(json<{ error: string }>(reply)).toEqual({ error: "busy" });
		expect((await getW("project/diff?snapshot=0123456789abcdef&file=0", grant)).status).toBe(429);
	});

	it("drop what they read when the session ends, and answer nothing after", async () => {
		const repo = demoRepo();
		const { pair, getW, broker } = await start({
			project: new GitProjectInspectorV0({ cwd: repo, minRefreshMs: 0 }),
		});
		const grant = await pair();
		const project = json<EndoWorkbenchProjectV0>(await getW("project", grant));
		broker.endSession();
		expect((await getW("project", grant)).status).toBe(401);
		expect((await getW(`project/diff?snapshot=${project.snapshot}&file=0`, grant)).status).toBe(401);
	});

	it("never put a path, a branch or a line of source into canonical evidence, the event store or a log", async () => {
		const repo = demoRepo();
		write(repo, "src/parser/stream.ts", "export const CANARY_SOURCE_LINE = 1;\n");
		const { pair, getW, root } = await start({ project: new GitProjectInspectorV0({ cwd: repo, minRefreshMs: 0 }) });
		const grant = await pair();
		const project = json<EndoWorkbenchProjectV0>(await getW("project", grant));
		for (const file of project.changes.files)
			await getW(`project/diff?snapshot=${project.snapshot}&file=${file.id}`, grant);
		const everything = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
				e.isDirectory() ? everything(join(dir, e.name)) : [join(dir, e.name)],
			);
		for (const file of everything(root)) {
			const text = readFileSync(file).toString("latin1");
			expect(text, file).not.toContain("CANARY_SOURCE_LINE");
			expect(text, file).not.toContain("tokenizer.ts");
			expect(text, file).not.toContain(repo);
		}
	});
});

describe("the protocol's closed lists and the page's copies of them", () => {
	it("are the same, so a reason the broker can give is one the page can word", async () => {
		const wire = await import("../studio-ui/src/model/project-wire.ts");
		const words = await import("../studio-ui/src/model/project.ts");
		const sorted = (list: readonly string[]) => [...list].sort();
		expect(sorted(wire.PROJECT_REASONS)).toEqual(sorted(ENDO_PROJECT_REASONS_V0));
		expect(sorted(wire.PROJECT_INCOMPLETE)).toEqual(sorted(ENDO_PROJECT_INCOMPLETE_V0));
		expect(sorted(wire.DIFF_REASONS)).toEqual(sorted(ENDO_DIFF_REASONS_V0));
		expect(sorted(Object.keys(words.REASON_WORDS))).toEqual(sorted(ENDO_PROJECT_REASONS_V0));
		expect(sorted(Object.keys(words.INCOMPLETE_WORDS))).toEqual(sorted(ENDO_PROJECT_INCOMPLETE_V0));
		expect(sorted(Object.keys(words.DIFF_REASON_WORDS))).toEqual(sorted(ENDO_DIFF_REASONS_V0));
	});
});
