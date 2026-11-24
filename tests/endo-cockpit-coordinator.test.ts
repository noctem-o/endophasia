import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEndoCoordinatorStatusV0 } from "../adapters/develop/coordinator-status.ts";
import { EndoCockpitCoordinatorV0 } from "../cockpit-http/coordinator.ts";
import { EndoWorkspaceHostV0 } from "../cockpit-http/workspace-host.ts";
import { validateEndoCoordinatorStatusV0 } from "../protocol/coordinator-status.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { readDirectoryNamesAtMostV0 } from "../storage/write-once.ts";
import { readCoordinatorStatus } from "../studio-ui/src/coordinator/read.ts";
import { capabilityOf, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import {
	buildCoordinatorStoreV0,
	buildMissionBoardFixtureV0,
	cleanCoordinatorFixturesV0,
} from "./coordinator-status-fixture.ts";
import { haveGit } from "./git-fixtures.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await stopServers();
	cleanCoordinatorFixturesV0();
});

describe.skipIf(!haveGit)("paired Coordinator read", () => {
	async function open() {
		const { root, repo, projectId, taskId } = await buildCoordinatorStoreV0({
			checkArgv: ["node", "ok.mjs", "fixture-private-arg"],
		});
		const tasks = new DevelopTasksStoreV0(root);
		const service = new DevelopWorkspaceServiceV0(tasks);
		const host = new EndoWorkspaceHostV0({
			open: (facts) => service.forLaunch({ projectId, launchDirectory: repo }, facts),
		});
		const server = await serve(root, { workbench: host });
		const base = `${capabilityOf(server)}/api/v0/workbench`;
		const paired = await host.handle({
			method: "POST",
			route: ["pair"],
			grant: null,
			query: "",
			body: { code: host.issuePairingCode().code },
		});
		const grant = (paired.body as { grant: string }).grant;
		const get = (route: string) => send(server, `${base}/${route}`, { headers: { "X-Endo-Grant": grant } });
		return { root, repo, projectId, taskId, tasks, host, server, base, get };
	}

	it("keeps the existing workspace route response identical across a Coordinator read", async () => {
		const { get, server, base, projectId } = await open();
		expect((await send(server, `${base}/workspace/coordinator`)).status).toBe(401);
		expect((await get("workspace/coordinator?project=other")).status).toBe(400);
		const before = await get("workspace");
		expect(before.status).toBe(200);
		const result = await get("workspace/coordinator");
		expect(result.status).toBe(200);
		expect(result.body).not.toContain("fixture-private-arg");
		const status = validateEndoCoordinatorStatusV0(JSON.parse(result.body));
		expect(status.scope.requested).toEqual([projectId]);
		expect(status.sessions).toEqual([]);
		expect(status.unlistedSessions.unknownRelationship).toBe(1);
		expect((await get("workspace")).body).toBe(before.body);
	});

	it("refuses data when the grant is lost between the read and the response", async () => {
		const { get, host } = await open();
		const read = EndoCockpitCoordinatorV0.prototype.read;
		vi.spyOn(EndoCockpitCoordinatorV0.prototype, "read").mockImplementation(async function (
			this: EndoCockpitCoordinatorV0,
			...args
		) {
			const answer = await read.apply(this, args);
			expect(answer.status).toBe(200);
			host.revoke();
			return answer;
		});
		const response = await get("workspace/coordinator");
		expect([response.status, JSON.parse(response.body)]).toEqual([401, { error: "grant-required" }]);
	});

	it("refuses a previously readable project when its launch directory disappears", async () => {
		const { get, repo } = await open();
		expect((await get("workspace/coordinator")).status).toBe(200);
		renameSync(repo, `${repo}-moved`);
		try {
			const response = await get("workspace/coordinator");
			expect([response.status, JSON.parse(response.body)]).toEqual([403, { error: "forbidden" }]);
		} finally {
			renameSync(`${repo}-moved`, repo);
		}
	});

	it("reports incomplete receipt evidence with a gap when the read budget is exhausted", async () => {
		const { root, projectId } = await open();
		const status = validateEndoCoordinatorStatusV0(
			await readEndoCoordinatorStatusV0({
				root,
				projects: [projectId],
				budget: {
					eventsBytes: 1,
					attemptEntries: 16,
					attemptBytes: 1024 * 1024,
					receiptFiles: 16,
					receiptBytes: 1,
				},
			}),
		);
		const task = status.projects[0]?.tasks[0];
		expect(task?.verification).toMatchObject({ incomplete: true, freshness: { state: "incomplete" }, results: [] });
		expect(task?.gaps.map(({ code }) => code)).toContain("receipts-skipped-at-limit");
		expect(status.sources.events.state).toBe("unavailable");
		expect(status.findings.map(({ code }) => code)).toContain("event-log-unavailable");
	});

	it("rejects malformed session.links[].source and non-operator decisionAuthority in protocol and Studio validators", async () => {
		const { status } = await buildMissionBoardFixtureV0();
		expect(readCoordinatorStatus(status)).not.toBeNull();
		const badSource = structuredClone(status) as unknown as {
			sessions: { links: { source: unknown }[] }[];
		};
		expect(badSource.sessions[0]?.links.length).toBeGreaterThan(0);
		badSource.sessions[0]!.links[0]!.source = { crash: true };
		expect(() => validateEndoCoordinatorStatusV0(badSource)).toThrow();
		expect(readCoordinatorStatus(badSource)).toBeNull();

		const badAuthority = structuredClone(status) as unknown as { authority: { decisionAuthority: unknown } };
		badAuthority.authority.decisionAuthority = "agent";
		expect(() => validateEndoCoordinatorStatusV0(badAuthority)).toThrow();
		expect(readCoordinatorStatus(badAuthority)).toBeNull();
	});

	it("bounds negative directory limits and charges temporary receipt entries across attempts", async () => {
		const { root, projectId, taskId } = await open();
		expect(readDirectoryNamesAtMostV0(join(root, "develop"), -1)).toBeNull();
		const tasks = new DevelopTasksStoreV0(root);
		const attempts = new DevelopAttemptsStoreV0(root);
		const svc = new DevelopAttemptsServiceV0(tasks, attempts);
		const a2 = svc.prepare(projectId, taskId, { objective: "Second attempt for temp enumeration bound" });
		const a3 = svc.prepare(projectId, taskId, { objective: "Third attempt for temp enumeration bound" });
		expect(a2.ok && a3.ok).toBe(true);
		if (!a2.ok || !a3.ok) throw new Error("prepare failed");
		for (const id of [a2.value.id, a3.value.id]) {
			const dir = join(root, "develop", "receipts", id);
			mkdirSync(dir, { recursive: true });
			for (let i = 0; i < 6; i += 1) {
				writeFileSync(join(dir, `.tmp-100-${i.toString(16).padStart(12, "0")}`), "{}");
			}
		}
		const status = validateEndoCoordinatorStatusV0(
			await readEndoCoordinatorStatusV0({
				root,
				projects: [projectId],
				budget: {
					eventsBytes: 1024 * 1024,
					attemptEntries: 64,
					attemptBytes: 1024 * 1024,
					receiptFiles: 8,
					receiptBytes: 1024 * 1024,
				},
			}),
		);
		const task = status.projects[0]?.tasks[0];
		expect(task?.gaps.map(({ code }) => code)).toContain("receipts-skipped-at-limit");
	});
});
