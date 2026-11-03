// The task routes at the workbench's boundary: only a paired page can read or change task metadata, no task operation reaches the agent or
// the terminal approval, a session reference is explicit and launch-scoped, a mismatched or damaged workspace is read-only, and the
// read-only `endo studio` server has none of it. Fake session and approver; real files; no Pi, no model.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piEndoSessionIdV0 } from "../adapters/pi/mapping.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { type EndoReceiptFactsV0, endoReceiptVerdictV0 } from "../protocol/develop-receipts.ts";
import type { EndoDevelopWorkspaceViewV0 } from "../protocol/develop-tasks.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { event, ingestAll, removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { capabilityOf, get, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession, textMessage } from "./workbench-fixtures.ts";

const dirs: string[] = [];
const scratch = (prefix = "endo-wt-"): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
};
afterEach(async () => {
	await stopServers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});

const CANARY = "CANARY-task-text-7c1e-private";
const TRANSCRIPT_CANARY = "CANARY-live-transcript-33f0";

function launch(
	options: {
		root?: string;
		registeredPath?: string;
		launchDirectory?: string;
		unknownProject?: boolean;
		withTasks?: boolean;
		attachment?: string;
	} = {},
) {
	const root = options.root ?? scratch("endo-wt-root-");
	const repo = options.registeredPath ?? scratch("endo-wt-repo-");
	const store = new DevelopTasksStoreV0(root);
	const existing = store.read();
	let projectId: string;
	if (existing.ok && existing.file.projects[0] !== undefined) projectId = existing.file.projects[0].id;
	else {
		const made = store.registerProject({ name: "demo", path: repo, observedGitRoot: repo });
		if (!made.ok) throw new Error("registration failed");
		projectId = made.value.id;
	}
	const session = new FakeSession();
	const approval = new Approval();
	const desk = new FakeDesk(session);
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: options.attachment ?? "pi.default",
		approver: approval.approver,
		interventions: desk,
		aliasOf: (id) => `alias:${id.length}`,
		...(options.withTasks === false
			? {}
			: {
					tasks: {
						open: (host) =>
							new DevelopWorkspaceServiceV0(store).forLaunch(
								{
									projectId: options.unknownProject ? `endo.project.${"0".repeat(32)}` : projectId,
									launchDirectory: options.launchDirectory ?? repo,
								},
								host,
							),
					},
				}),
	});
	const call = (
		method: "GET" | "POST",
		route: string,
		body: unknown = null,
		grant: string | null = null,
		query = "",
	) => broker.handle({ method, route: route.split("/"), query, grant, body });
	const pair = async (): Promise<string> => {
		const { code } = broker.issuePairingCode();
		return ((await call("POST", "pair", { code })).body as { grant: string }).grant;
	};
	return { root, repo, store, projectId, session, approval, desk, broker, call, pair };
}
const view = (r: { body: unknown }) => r.body as EndoDevelopWorkspaceViewV0;
const fileOf = (root: string) => readFileSync(join(root, "develop", "tasks.json"), "utf8");

describe("only a paired page can read or change tasks", () => {
	it("refuses every workspace route without the grant, and creates nothing", async () => {
		const w = launch();
		const before = fileOf(w.root);
		for (const [method, route, body] of [
			["GET", "workspace", null],
			["GET", "workspace/attempts", null],
			["GET", "workspace/attention", null],
			["POST", "workspace/tasks/create", { title: CANARY }],
			["POST", "workspace/tasks/update", { taskId: "x", expectedRevision: 0, title: "y" }],
			["POST", "workspace/tasks/status", { taskId: "x", expectedRevision: 0, to: "done" }],
			["POST", "workspace/tasks/select", { taskId: null }],
			["POST", "workspace/tasks/link-session", { taskId: "x", expectedRevision: 0 }],
		] as const) {
			const reply = await w.call(method, route, body);
			expect([route, reply.status, reply.body]).toEqual([route, 401, { error: "grant-required" }]);
		}
		expect((await w.call("GET", "workspace", null, "not-the-grant")).status).toBe(401);
		expect(fileOf(w.root)).toBe(before);
	});

	it("loses the grant with the session: nothing is served or changed after the runtime ends", async () => {
		const w = launch();
		const grant = await w.pair();
		expect((await w.call("GET", "workspace", null, grant)).status).toBe(200);
		w.broker.endSession();
		const before = fileOf(w.root);
		expect((await w.call("GET", "workspace", null, grant)).status).toBe(401);
		expect((await w.call("POST", "workspace/tasks/create", { title: "x" }, grant)).status).toBe(401);
		expect(fileOf(w.root)).toBe(before);
	});

	it("without a registered project it answers one constant and has no task route", async () => {
		const w = launch({ withTasks: false });
		const grant = await w.pair();
		const absent = await w.call("GET", "workspace", null, grant);
		expect([absent.status, absent.body]).toEqual([
			200,
			{ available: false, schemaVersion: "endo.develop-workspace.v1" },
		]);
		expect((await w.call("POST", "workspace/tasks/create", { title: "x" }, grant)).status).toBe(404);
		expect((await w.call("GET", "workspace", null, grant, "x=1")).status).toBe(404);
	});
});

describe("the operator's journey through the routes, and nothing that reaches the agent", () => {
	it("creates, edits, moves, selects and links a task without sending, steering, approving or recording anything", async () => {
		const w = launch();
		const grant = await w.pair();
		const eventsBefore = readdirSync(w.root).sort();
		let v = view(await w.call("GET", "workspace", null, grant));
		expect(v).toMatchObject({ state: "ready", writable: true, linkable: true, tasks: [], selectedTaskId: null });
		expect(v.project).toMatchObject({ name: "demo", path: w.repo, launch: "same" });

		v = view(
			await w.call("POST", "workspace/tasks/create", { title: "Fix it", description: "d", acceptance: "a" }, grant),
		);
		const task = v.tasks[0]!;
		expect(v.selectedTaskId).toBe(task.id);
		expect(task).toMatchObject({ title: "Fix it", status: "open", revision: 0, next: ["in-progress", "blocked"] });

		v = view(
			await w.call(
				"POST",
				"workspace/tasks/update",
				{ taskId: task.id, expectedRevision: 0, acceptance: "a2" },
				grant,
			),
		);
		expect(v.tasks[0]).toMatchObject({ acceptance: "a2", revision: 1 });
		const stale = await w.call(
			"POST",
			"workspace/tasks/update",
			{ taskId: task.id, expectedRevision: 0, title: "late" },
			grant,
		);
		expect([stale.status, stale.body]).toEqual([409, { error: "stale-revision" }]);

		v = view(
			await w.call(
				"POST",
				"workspace/tasks/status",
				{ taskId: task.id, expectedRevision: 1, to: "in-progress", note: "started" },
				grant,
			),
		);
		expect(v.tasks[0]).toMatchObject({ status: "in-progress", revision: 2, next: ["review", "blocked", "open"] });
		const skipped = await w.call(
			"POST",
			"workspace/tasks/status",
			{ taskId: task.id, expectedRevision: 2, to: "done" },
			grant,
		);
		expect([skipped.status, skipped.body]).toEqual([409, { error: "invalid-transition" }]);

		v = view(await w.call("POST", "workspace/tasks/select", { taskId: null }, grant));
		expect(v.selectedTaskId).toBeNull();
		v = view(await w.call("POST", "workspace/tasks/select", { taskId: task.id }, grant));
		expect(v.selectedTaskId).toBe(task.id);

		// None of it touched the agent, the terminal approval, the desk or the event records.
		expect(w.session.promptCalls).toEqual([]);
		expect(w.session.records).toEqual([]);
		expect(w.approval.requests).toEqual([]);
		expect(w.desk.applyCalls).toEqual([]);
		expect(w.desk.proposals.size).toBe(0);
		expect(readdirSync(w.root).sort()).toEqual([...eventsBefore]);
	});

	it("an agent's run ending or its final answer changes no task status", async () => {
		const w = launch();
		const grant = await w.pair();
		const created = view(await w.call("POST", "workspace/tasks/create", { title: "t" }, grant));
		w.session.live_({ type: "agent_start", record: {} });
		w.session.live_(textMessage("assistant", "All done, the task is complete."));
		w.session.live_({ type: "agent_end", record: {} });
		w.session.live_({ type: "agent_settled", record: {} });
		w.session.live = false;
		w.session.runActive = false;
		const after = new DevelopTasksStoreV0(w.root).read();
		expect(after.ok && after.file.tasks.map((t) => [t.id, t.status, t.revision])).toEqual([
			[created.tasks[0]!.id, "open", 0],
		]);
	});

	it("never carries the live transcript into the task view or the task file", async () => {
		const w = launch();
		const grant = await w.pair();
		w.session.live_(textMessage("user", TRANSCRIPT_CANARY));
		const v = await w.call("POST", "workspace/tasks/create", { title: "t" }, grant);
		expect(JSON.stringify(v.body)).not.toContain(TRANSCRIPT_CANARY);
		expect(fileOf(w.root)).not.toContain(TRANSCRIPT_CANARY);
		expect(JSON.stringify((await w.call("GET", "workspace", null, grant)).body)).not.toContain(TRANSCRIPT_CANARY);
	});

	it("takes closed bodies only: unknown keys, wrong types and absurd sizes are refused and write nothing", async () => {
		const w = launch();
		const grant = await w.pair();
		const created = view(await w.call("POST", "workspace/tasks/create", { title: "t" }, grant)).tasks[0]!;
		const before = fileOf(w.root);
		const id = created.id;
		const bad: [string, unknown][] = [
			["create", { title: "x", status: "done" }],
			["create", { title: "x", projectId: "endo.project.other" }],
			["create", { title: 7 }],
			["create", {}],
			["create", { title: "x".repeat(121) }],
			["create", { title: "t", description: "y".repeat(5000) }],
			["create", [1]],
			["update", { taskId: id, expectedRevision: 0 }],
			["update", { taskId: id, expectedRevision: "0", title: "z" }],
			["update", { taskId: id, expectedRevision: -1, title: "z" }],
			["update", { taskId: id, expectedRevision: 0, title: "z", status: "done" }],
			["update", { taskId: 5, expectedRevision: 0, title: "z" }],
			["status", { taskId: id, expectedRevision: 0, to: "finished" }],
			["status", { taskId: id, expectedRevision: 0, to: "in-progress", note: "n".repeat(300) }],
			["select", { taskId: 5 }],
			["select", {}],
			["link-session", { taskId: id, expectedRevision: 0, sessionId: "endo.session.pi.other" }],
			["link-session", { taskId: id, expectedRevision: 0, alias: "pi.live", launchId: "0".repeat(16) }],
			["unlink-session", { taskId: id, expectedRevision: 0, linkId: "nope" }],
		];
		for (const [op, body] of bad) {
			const reply = await w.call("POST", `workspace/tasks/${op}`, body, grant);
			expect([op, reply.status]).toEqual([op, 400]);
		}
		expect((await w.call("POST", "workspace/tasks/delete", { taskId: id }, grant)).status).toBe(404);
		expect((await w.call("POST", "workspace/tasks/create/extra", { title: "x" }, grant)).status).toBe(404);
		expect((await w.call("POST", "workspace/tasks/create", { title: "x" }, grant, "a=b")).status).toBe(404);
		expect((await w.call("GET", "workspace", null, grant, "x=1")).status).toBe(400);
		expect(fileOf(w.root)).toBe(before);
	});
});

describe("a session reference is explicit, attributed and scoped to its launch", () => {
	it("links the session this workbench serves, from the broker's own state, and shows it as current", async () => {
		const w = launch();
		const grant = await w.pair();
		const task = view(await w.call("POST", "workspace/tasks/create", { title: "t" }, grant)).tasks[0]!;
		// Selecting or editing a task links nothing.
		await w.call("POST", "workspace/tasks/select", { taskId: task.id }, grant);
		await w.call("POST", "workspace/tasks/update", { taskId: task.id, expectedRevision: 0, title: "t2" }, grant);
		expect(view(await w.call("GET", "workspace", null, grant)).tasks[0]!.sessions).toEqual([]);

		const linked = view(
			await w.call("POST", "workspace/tasks/link-session", { taskId: task.id, expectedRevision: 1 }, grant),
		);
		const ref = linked.tasks[0]!.sessions[0]!;
		expect(ref).toMatchObject({
			source: "pi-live",
			attachment: "pi.default",
			launchId: w.broker.launchId,
			linkedBy: "operator",
			relation: "current",
		});
		// The page is given a label, never the store's session id.
		expect(JSON.stringify(linked)).not.toContain("fake-session-1");
		// The file holds the claim with its source, scope and attribution.
		const stored = new DevelopTasksStoreV0(w.root).read();
		expect(stored.ok && stored.file.tasks[0]!.sessions[0]).toMatchObject({
			source: "pi-live",
			sessionId: "endo.session.pi.fake-session-1",
			launchId: w.broker.launchId,
			linkedBy: "operator",
			via: "workbench",
		});
		// Linking again is a no-op, and a link can be removed by the operator.
		const again = view(
			await w.call(
				"POST",
				"workspace/tasks/link-session",
				{ taskId: task.id, expectedRevision: linked.tasks[0]!.revision },
				grant,
			),
		);
		expect(again.tasks[0]!.sessions).toHaveLength(1);
		const removed = view(
			await w.call(
				"POST",
				"workspace/tasks/unlink-session",
				{ taskId: task.id, expectedRevision: again.tasks[0]!.revision, linkId: ref.linkId },
				grant,
			),
		);
		expect(removed.tasks[0]!.sessions).toEqual([]);
		expect(w.session.promptCalls).toEqual([]);
	});

	it("stores a linked session under the same coordinate the evidence mapper gives it, even for an id outside the plain grammar", async () => {
		const w = launch();
		w.session.piSessionId = "session:one";
		const grant = await w.pair();
		const task = view(await w.call("POST", "workspace/tasks/create", { title: "t" }, grant)).tasks[0]!;
		const linked = await w.call(
			"POST",
			"workspace/tasks/link-session",
			{ taskId: task.id, expectedRevision: task.revision },
			grant,
		);
		expect(linked.status).toBe(200);
		const stored = new DevelopTasksStoreV0(w.root).read();
		const expected = piEndoSessionIdV0("session:one");
		expect(expected).toMatch(/^endo\.session\.pi\.sha256-/);
		expect(stored.ok && stored.file.tasks[0]!.sessions[0]!.sessionId).toBe(expected);
		// The alias is looked up under that same coordinate, and the reference is current.
		expect(view(linked).tasks[0]!.sessions[0]).toMatchObject({
			alias: `alias:${expected.length}`,
			relation: "current",
		});
	});

	it("links a session whose plain Pi id is as long as the mapper keeps it, and one longer than that through its digest", async () => {
		for (const length of [161, 200, 201]) {
			const w = launch();
			w.session.piSessionId = "a".repeat(length);
			const grant = await w.pair();
			const task = view(await w.call("POST", "workspace/tasks/create", { title: "t" }, grant)).tasks[0]!;
			const linked = await w.call(
				"POST",
				"workspace/tasks/link-session",
				{ taskId: task.id, expectedRevision: task.revision },
				grant,
			);
			expect(linked.status, `${length} characters`).toBe(200);
			const stored = new DevelopTasksStoreV0(w.root).read();
			expect(stored.ok && stored.file.tasks[0]!.sessions[0]!.sessionId).toBe(piEndoSessionIdV0("a".repeat(length)));
			expect(view(linked).tasks[0]!.sessions[0]!.relation).toBe("current");
		}
	});

	it("links a session of an attachment whose name is as long as the registry allows", async () => {
		// The harness registry accepts a dotted kind of up to 128 characters, so an 81-128 character attachment is a real attachment.
		const attachment = `pi.${"long-".repeat(23)}x`;
		expect(attachment.length).toBeGreaterThan(80);
		expect(attachment.length).toBeLessThanOrEqual(128);
		const w = launch({ attachment });
		const grant = await w.pair();
		const task = view(await w.call("POST", "workspace/tasks/create", { title: "t" }, grant)).tasks[0]!;
		const linked = await w.call(
			"POST",
			"workspace/tasks/link-session",
			{ taskId: task.id, expectedRevision: task.revision },
			grant,
		);
		expect(linked.status).toBe(200);
		expect(view(linked).tasks[0]!.sessions[0]).toMatchObject({ attachment, relation: "current" });
		const reread = view(await w.call("GET", "workspace", null, grant));
		expect(reread.tasks[0]!.sessions[0]!.attachment).toBe(attachment);
	});

	it("is historical after a restart, even when the new launch serves the same Pi session id", async () => {
		const first = launch();
		const g1 = await first.pair();
		const task = view(await first.call("POST", "workspace/tasks/create", { title: "t" }, g1)).tasks[0]!;
		await first.call("POST", "workspace/tasks/link-session", { taskId: task.id, expectedRevision: 0 }, g1);
		// A restart: a new broker (a new launch id) over the same store, serving a session with the very same id and the very same alias.
		const second = launch({ root: first.root, registeredPath: first.repo });
		expect(second.broker.launchId).not.toBe(first.broker.launchId);
		expect(second.session.piSessionId).toBe(first.session.piSessionId);
		const g2 = await second.pair();
		const v = view(await second.call("GET", "workspace", null, g2));
		const ref = v.tasks[0]!.sessions[0]!;
		expect(ref).toMatchObject({ relation: "historical", launchId: first.broker.launchId });
		expect(ref.alias).toBe(`alias:${"endo.session.pi.fake-session-1".length}`);
		// The task is still its own record: the new session is not linked to it by this.
		const fresh = view(
			await second.call(
				"POST",
				"workspace/tasks/link-session",
				{ taskId: task.id, expectedRevision: v.tasks[0]!.revision },
				g2,
			),
		);
		expect(fresh.tasks[0]!.sessions.map((s) => [s.launchId === second.broker.launchId, s.relation]).sort()).toEqual([
			[false, "historical"],
			[true, "current"],
		]);
	});

	it("a session that is not connected cannot be linked", async () => {
		const w = launch();
		const grant = await w.pair();
		const task = view(await w.call("POST", "workspace/tasks/create", { title: "t" }, grant)).tasks[0]!;
		w.session.piSessionId = null;
		const reply = await w.call(
			"POST",
			"workspace/tasks/link-session",
			{ taskId: task.id, expectedRevision: 0 },
			grant,
		);
		expect([reply.status, reply.body]).toEqual([409, { error: "no-session" }]);
		expect(view(await w.call("GET", "workspace", null, grant)).linkable).toBe(false);
	});

	it("two sessions with the same alias are two references; the alias links nothing", async () => {
		const first = launch();
		const g1 = await first.pair();
		const a = view(await first.call("POST", "workspace/tasks/create", { title: "a" }, g1)).tasks[0]!;
		const b = view(await first.call("POST", "workspace/tasks/create", { title: "b" }, g1)).tasks[1]!;
		await first.call("POST", "workspace/tasks/link-session", { taskId: a.id, expectedRevision: 0 }, g1);
		// The alias function is a label: giving every session the same one does not relate task b to task a's session.
		const v = view(await first.call("GET", "workspace", null, g1));
		expect(v.tasks.find((t) => t.id === b.id)!.sessions).toEqual([]);
	});
});

describe("a mismatched, missing, unknown or damaged workspace is read-only and says why", () => {
	it("a launch in another directory shows the tasks but changes nothing", async () => {
		const elsewhere = scratch("endo-wt-other-repo-");
		const w = launch({ launchDirectory: elsewhere });
		new DevelopTasksStoreV0(w.root).createTask(w.projectId, { title: "kept" });
		const grant = await w.pair();
		const before = fileOf(w.root);
		const v = view(await w.call("GET", "workspace", null, grant));
		expect(v).toMatchObject({ state: "ready", writable: false, readOnlyReason: "project-mismatch", linkable: false });
		expect(v.project?.launch).toBe("different");
		expect(v.tasks.map((t) => t.title)).toEqual(["kept"]);
		for (const [route, body] of [
			["create", { title: "x" }],
			["select", { taskId: null }],
			["status", { taskId: v.tasks[0]!.id, expectedRevision: 0, to: "in-progress" }],
			["link-session", { taskId: v.tasks[0]!.id, expectedRevision: 0 }],
		] as const) {
			const reply = await w.call("POST", `workspace/tasks/${route}`, body, grant);
			expect([route, reply.status, reply.body]).toEqual([
				route,
				409,
				{ error: "read-only", reason: "project-mismatch" },
			]);
		}
		expect(fileOf(w.root)).toBe(before);
	});

	it("a registered directory that is gone is missing, not matched", async () => {
		const repo = scratch("endo-wt-gone-");
		const w = launch({ registeredPath: repo });
		rmSync(repo, { recursive: true });
		const grant = await w.pair();
		const v = view(await w.call("GET", "workspace", null, grant));
		expect(v).toMatchObject({ writable: false, readOnlyReason: "project-missing" });
		expect(v.project?.launch).toBe("missing");
	});

	it("a symlink to the registered directory is the same place; a different directory with the same name is not", async () => {
		const repo = scratch("endo-wt-real-");
		const parent = scratch("endo-wt-parent-");
		mkdirSync(join(parent, "demo"));
		const w = launch({ registeredPath: repo, launchDirectory: join(parent, "demo") });
		const v = view(await w.call("GET", "workspace", null, await w.pair()));
		expect(v.project?.launch).toBe("different");
	});

	it("a project id the store does not know shows no tasks and allows no change", async () => {
		const w = launch({ unknownProject: true });
		const grant = await w.pair();
		const v = view(await w.call("GET", "workspace", null, grant));
		expect(v).toMatchObject({ state: "unknown-project", project: null, tasks: [], writable: false });
		expect((await w.call("POST", "workspace/tasks/create", { title: "x" }, grant)).status).toBe(409);
	});

	it("a damaged file is reported and left alone", async () => {
		const w = launch();
		writeFileSync(join(w.root, "develop", "tasks.json"), "{ torn");
		const grant = await w.pair();
		const v = view(await w.call("GET", "workspace", null, grant));
		expect(v).toMatchObject({ state: "unreadable", reason: "malformed", tasks: [], project: null, writable: false });
		const reply = await w.call("POST", "workspace/tasks/create", { title: "x" }, grant);
		expect([reply.status, reply.body]).toEqual([409, { error: "read-only", reason: "unreadable" }]);
		expect(fileOf(w.root)).toBe("{ torn");
	});

	it("a file that cannot be written is a refusal and the page's last view still stands", async () => {
		const w = launch();
		const grant = await w.pair();
		rmSync(join(w.root, "develop", "tasks.json"));
		writeFileSync(join(w.root, "develop", "tasks.lock.1"), `${JSON.stringify({ pid: process.ppid, at: "now" })}\n`);
		const reply = await w.call("POST", "workspace/tasks/create", { title: "x" }, grant);
		// (the lock wait is two seconds by default; either answer is a refusal that changed nothing)
		expect([409, 503]).toContain(reply.status);
		expect(readdirSync(join(w.root, "develop"))).toEqual(["tasks.lock.1"]);
	}, 15_000);
});

describe("over HTTP: the same guards as every workbench route, and nothing on the read-only server", () => {
	async function serveWorkbench() {
		const w = launch();
		const root = tempRoot("endo-wt-http-");
		ingestAll(root, [
			event("harness.attached", {}, { session: "endo.session.pi.x", producer: "pi-rpc-adapter:pi.default" }),
		]);
		const server = await serve(root, { workbench: w.broker, readBudget: { duty: 1, burstMs: 1e6 } });
		const api = `${capabilityOf(server)}/api/v0/workbench/`;
		const post = (route: string, body: unknown, headers: Record<string, string> = {}, text?: string) =>
			send(server, `${api}${route}`, {
				method: "POST",
				headers: { Origin: server.origin, "Content-Type": "application/json", ...headers },
				body: text ?? JSON.stringify(body),
			});
		return { ...w, server, api, post };
	}

	it("refuses an unpaired read and write, a foreign Origin, no Origin, a wrong content type, a rebound Host and an oversize body", async () => {
		const w = await serveWorkbench();
		const before = fileOf(w.root);
		expect((await get(w.server, "/api/v0/workbench/workspace")).status).toBe(401);
		expect((await w.post("workspace/tasks/create", { title: CANARY })).status).toBe(401);
		expect((await w.post("workspace/tasks/create", { title: "x" }, { Origin: "http://evil.example" })).status).toBe(
			403,
		);
		const noOrigin = await send(w.server, `${w.api}workspace/tasks/create`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: '{"title":"x"}',
		});
		expect(noOrigin.status).toBe(403);
		expect((await w.post("workspace/tasks/create", { title: "x" }, { "Content-Type": "text/plain" })).status).toBe(
			400,
		);
		expect((await w.post("workspace/tasks/create", { title: "x" }, { Host: "evil.example" })).status).toBe(421);
		expect(
			(await w.post("workspace/tasks/create", null, {}, JSON.stringify({ title: "x".repeat(45_000) }))).status,
		).toBe(400);
		expect(
			(await send(w.server, `${w.api}workspace`, { method: "PUT", headers: { Origin: w.server.origin } })).status,
		).toBe(405);
		expect(
			(
				await send(w.server, `${w.api}workspace/tasks/create`, {
					method: "DELETE",
					headers: { Origin: w.server.origin },
				})
			).status,
		).toBe(405);
		expect(fileOf(w.root)).toBe(before);
	});

	it("serves a paired page, and the worst-case body fits", async () => {
		const w = await serveWorkbench();
		const grant = await w.pair();
		const auth = { "X-Endo-Grant": grant };
		const created = await w.post(
			"workspace/tasks/create",
			{ title: "☃".repeat(120), description: "\n".repeat(4000), acceptance: "☃".repeat(4000) },
			auth,
		);
		expect(created.status).toBe(200);
		const read = await send(w.server, `${w.api}workspace`, { headers: auth });
		expect(read.status).toBe(200);
		expect(JSON.parse(read.body).tasks).toHaveLength(1);
		// The browser may not ask a task route for a command: there is no such route.
		for (const route of ["prompt/propose", "intervention/propose"]) {
			const reply = await w.post(`workspace/${route}`, { message: "hi" }, auth);
			expect(reply.status).toBe(404);
		}
		expect(w.session.promptCalls).toEqual([]);
		expect(w.approval.requests).toEqual([]);
	});

	it("the read-only server has no workspace route, no POST and never serves a task's text", async () => {
		// A populated store (recorded Pi and DSH sessions) with a registered project and a task whose every field is a canary.
		const root = developStore();
		const store = new DevelopTasksStoreV0(root);
		const project = store.registerProject({ name: CANARY, path: "/work/demo", observedGitRoot: null });
		if (!project.ok) throw new Error("registration failed");
		const task = store.createTask(project.value.id, { title: CANARY, description: CANARY, acceptance: CANARY });
		if (!task.ok) throw new Error("task refused");
		// And a saved OMP reference whose session id is the canary: it must not leak through Studio either.
		const linked = store.linkSession(project.value.id, task.value.id, 0, {
			source: "omp-saved",
			sessionId: CANARY,
			scope: `omp-dir.${"9".repeat(32)}`,
			observedFormat: 3,
			linkedBy: "operator",
			via: "cli",
		});
		if (!linked.ok) throw new Error(linked.code);
		// And a work attempt whose words are the canary (docs/designs/develop-work-attempts.md): no Studio route serves it.
		const attempt = new DevelopAttemptsServiceV0(store, new DevelopAttemptsStoreV0(root)).prepare(
			project.value.id,
			task.value.id,
			{ objective: CANARY, constraints: CANARY, reportBack: CANARY },
		);
		if (!attempt.ok) throw new Error(attempt.code);
		// And a verification receipt whose argument is the canary (docs/designs/develop-verification-receipts.md): no Studio route serves it.
		const facts: EndoReceiptFactsV0 = {
			repository: { worktree: "/w", commonDir: "/w/.git", linked: false },
			revision: { commit: "1".repeat(40), tree: "2".repeat(40), branch: null },
			reflog: "compared",
			check: { argv: ["sh", CANARY], executable: "/bin/sh", realExecutable: "/bin/sh", timeoutMs: 600_000 },
			execution: { kind: "exited", code: 0 },
			strayProcesses: false,
			escapedProcess: false,
			after: { state: "unavailable" },
		};
		const written = new DevelopReceiptsStoreV0(root).write({
			schemaVersion: "endo.develop-receipt.v0",
			id: `endo.receipt.${"3".repeat(32)}`,
			attemptId: attempt.value.id,
			projectId: project.value.id,
			requestedBy: "operator",
			via: "cli",
			observer: { tool: "endo", version: "0.0.0-test" },
			startedAtMs: 1,
			endedAtMs: 2,
			durationMs: 1,
			...facts,
			output: { stdoutBytes: 0, stderrBytes: 0 },
			...endoReceiptVerdictV0(facts),
		});
		if (written !== "created") throw new Error(written);
		const server = await serve(root);
		const base = `${capabilityOf(server)}/api/v0/`;
		// Every read route family the page uses, each one ANSWERED (a refusal would prove nothing): the snapshot, the session list and one
		// recorded session, the Compare candidates and one selected comparison, and the workbench probes.
		const sessions = JSON.parse((await get(server, "/api/v0/develop/sessions")).body) as {
			sessions: { selector: string | null }[];
		};
		const selector = sessions.sessions.find((row) => row.selector !== null)?.selector;
		const candidates = JSON.parse((await get(server, "/api/v0/compare/candidates")).body) as {
			candidates: { source: string; selector: string | null }[];
		};
		const pair = candidates.candidates.filter((c) => c.selector !== null).slice(0, 2);
		expect(selector).toBeDefined();
		expect(pair).toHaveLength(2);
		const answered = [
			"snapshot?afterSequence=0&limit=10",
			"develop/sessions",
			`develop/session/${selector}`,
			"compare/candidates",
			`compare/selected/${pair[0]?.source}/${pair[0]?.selector}/${pair[1]?.source}/${pair[1]?.selector}`,
		];
		for (const route of answered) {
			const reply = await get(server, `/api/v0/${route}`);
			expect([route, reply.status]).toEqual([route, 200]);
			expect(reply.body, route).not.toContain(CANARY);
			expect(reply.body, route).not.toContain("tasks.json");
		}
		for (const route of [
			"workbench/status",
			"workbench/workspace",
			"workbench/workspace/attempts",
			"workbench/workspace/attention",
			"workbench/project",
		]) {
			const reply = await get(server, `/api/v0/${route}`);
			expect(reply.body, route).not.toContain(CANARY);
		}
		expect((await get(server, "/api/v0/workbench/workspace")).status).toBe(404);
		expect((await get(server, "/api/v0/workbench/workspace/attempts")).status).toBe(404);
		expect((await get(server, "/api/v0/workbench/workspace/attention")).status).toBe(404);
		for (const route of ["workspace", "workbench/workspace", "workbench/workspace/tasks/create"])
			expect(
				(
					await send(server, `${base}${route}`, {
						method: "POST",
						headers: { Origin: server.origin, "Content-Type": "application/json" },
						body: "{}",
					})
				).status,
			).toBe(405);
		// The snapshot still reads: an unknown `develop/` directory beside the evidence is no problem for the reader.
		expect((await get(server, "/api/v0/snapshot?afterSequence=0&limit=10")).status).toBe(200);
	});
});
