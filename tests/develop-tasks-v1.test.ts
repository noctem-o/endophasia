// DEVELOP Slice D: `endo.develop-tasks.v1`, source-aware references, the operator-visible v0 -> v1 upgrade, and linking an Oh My Pi saved
// session from the CLI. Temporary stores, synthetic OMP journals (tests/fixtures/omp-journals.ts), no Pi, no OMP process, no model.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { OmpSavedSessionObserverV0, ompScopeOfRootV0 } from "../adapters/omp/observer.ts";
import {
	ENDO_DEVELOP_TASKS_SCHEMA_V0,
	ENDO_DEVELOP_TASKS_SCHEMA_V1,
	type EndoDevelopOmpSessionRefV1,
	type EndoDevelopTasksFileV0,
	endoDevelopSessionKeyV1,
	endoDevelopTasksAsV0,
	readEndoDevelopTasksFileV0,
	readEndoDevelopTasksFileV1,
	upgradeEndoDevelopTasksV0toV1,
	validateEndoDevelopTasksFileV1,
} from "../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { type DevelopLaunchHostV0, DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { EndoWorkspaceRoutesV0 } from "../runtime/contracts/workspace-routes.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { readWorkspace } from "../studio-ui/src/model/workspace-wire.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { CANARY, header, resetIds, session } from "./fixtures/omp-journals.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-tasks-v1-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => resetIds());
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const dir = join(base, `${name}-${made}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const ID_A = "019a0000-0000-7000-8000-00000000000a";
const ID_B = "019a0000-0000-7000-8000-00000000000b";
const LAUNCH_A = "a".repeat(16);
const PI_ID = "endo.session.pi.pi-session-1";
const SCOPE_1 = `omp-dir.${"1".repeat(32)}`;
const SCOPE_2 = `omp-dir.${"2".repeat(32)}`;
const fileOf = (root: string) => readFileSync(join(root, "develop", "tasks.json"), "utf8");
const jsonOf = (root: string) => JSON.parse(fileOf(root)) as { schemaVersion: string; revision: number; tasks: any[] };
const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(r.code);
	return r.value;
};
const omp = (sessionId: string, scope = SCOPE_1): Omit<EndoDevelopOmpSessionRefV1, "linkId" | "linkedAtMs"> => ({
	source: "omp-saved",
	sessionId,
	scope,
	observedFormat: 3,
	linkedBy: "operator",
	via: "cli",
});
const pi = (sessionId = PI_ID, launchId = LAUNCH_A) =>
	({
		source: "pi-live",
		sessionId,
		attachment: "pi.default",
		launchId,
		linkedBy: "operator",
		via: "workbench",
	}) as const;

/** A store with one project and one selected task (revision 2: a status change, then a Pi reference), made by the store. */
function seeded() {
	const root = fresh("root");
	const project = fresh("project");
	const store = new DevelopTasksStoreV0(root, { now: () => 1_000 });
	const p = ok(store.registerProject({ name: "demo", path: project, observedGitRoot: null }));
	const t = ok(store.createTask(p.id, { title: "t", description: "d", acceptance: "a" }));
	ok(store.setStatus(p.id, t.id, 0, "in-progress", "started"));
	ok(store.selectTask(p.id, t.id));
	ok(store.linkSession(p.id, t.id, 1, pi()));
	return { root, project, store, projectId: p.id, taskId: t.id };
}

/** Rewrite a (Pi-only) v1 file as the v0 file a build from before v1 would have written: the same canonical bytes under v0. */
function asV0File(root: string): string {
	const v1 = validateEndoDevelopTasksFileV1(JSON.parse(fileOf(root)));
	const v0 = endoDevelopTasksAsV0(v1);
	if (v0 === null) throw new Error("not expressible in v0");
	const text = `${canonicalEndoJsonV0(v0 as never)}\n`;
	writeFileSync(join(root, "develop", "tasks.json"), text, { mode: 0o600 });
	return text;
}

function manifest(root: string): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const s = lstatSync(path, { bigint: true });
			const entry: unknown[] = [s.size, s.mtimeNs, s.ctimeNs, s.ino, s.mode];
			if (s.isFile()) entry.push(createHash("sha256").update(readFileSync(path)).digest("hex"));
			out[relative(root, path)] = entry.map(String);
			if (s.isDirectory()) walk(path);
		}
	};
	walk(root);
	return out;
}

// ---- the format ------------------------------------------------------------------------------------------------------------------------

describe("v1 is v0 with source-aware references, and nothing else", () => {
	it("v0 -> v1 is pure, deterministic, total and exactly reversible for a Pi-only file", () => {
		const w = seeded();
		const v0text = asV0File(w.root);
		const v0 = JSON.parse(v0text) as EndoDevelopTasksFileV0;
		const a = upgradeEndoDevelopTasksV0toV1(v0);
		const b = upgradeEndoDevelopTasksV0toV1(JSON.parse(v0text));
		expect(canonicalEndoJsonV0(a as never)).toBe(canonicalEndoJsonV0(b as never));
		// Every field but the version is the same value: projects, tasks, statuses, histories, selection, and the Pi reference exactly.
		const { schemaVersion: _a, ...restV1 } = a;
		const { schemaVersion: _b, ...restV0 } = v0;
		expect(restV1).toEqual(restV0);
		expect(a.tasks[0]!.sessions[0]).toEqual(v0.tasks[0]!.sessions[0]);
		expect(`${canonicalEndoJsonV0(endoDevelopTasksAsV0(a) as never)}\n`).toBe(v0text);
		// The input was not changed by the projection.
		expect(`${canonicalEndoJsonV0(v0 as never)}\n`).toBe(v0text);
	});

	it("a v1 file is refused whole by a build that knows only v0, and an unknown version or source by this one", () => {
		const v1 = { schemaVersion: ENDO_DEVELOP_TASKS_SCHEMA_V1, revision: 0, projects: [], tasks: [] };
		expect(readEndoDevelopTasksFileV0(v1)).toMatchObject({ ok: false, kind: "unsupported-version" });
		expect(readEndoDevelopTasksFileV1(v1)).toMatchObject({ ok: true });
		expect(readEndoDevelopTasksFileV1({ ...v1, schemaVersion: "endo.develop-tasks.v2" })).toMatchObject({
			ok: false,
			kind: "unsupported-version",
		});
		const w = seeded();
		const file = jsonOf(w.root);
		const withRef = (ref: unknown) => ({ ...file, tasks: [{ ...file.tasks[0], sessions: [ref] }] });
		const good = { ...omp(ID_A), linkId: "0".repeat(16), linkedAtMs: 1 };
		expect(readEndoDevelopTasksFileV1(withRef(good))).toMatchObject({ ok: true });
		for (const forged of [
			{ ...good, source: "codex-live" },
			{ ...good, relation: "current" },
			{ ...good, launchId: LAUNCH_A },
			{ ...good, attachment: "pi.default" },
			{ ...good, via: "workbench" },
			{ ...good, linkedBy: "agent" },
			{ ...good, scope: "/home/someone/.omp/agent/sessions" },
			{ ...good, scope: "omp-dir.short" },
			{ ...good, sessionId: `o1-${"0".repeat(32)}` },
			{ ...good, sessionId: "../x" },
			{ ...good, observedFormat: 4 },
			{ ...pi(), linkId: "0".repeat(16), linkedAtMs: 1, scope: SCOPE_1 },
			{ ...pi(), linkId: "0".repeat(16), linkedAtMs: 1, via: "cli" },
		])
			expect(readEndoDevelopTasksFileV1(withRef(forged)), JSON.stringify(forged)).toMatchObject({
				ok: false,
				kind: "invalid",
			});
		// v0 never accepts an OMP reference: it is not loosened.
		expect(
			readEndoDevelopTasksFileV0({ ...withRef(good), schemaVersion: ENDO_DEVELOP_TASKS_SCHEMA_V0 }),
		).toMatchObject({
			ok: false,
			kind: "invalid",
		});
	});

	it("the idempotence key is the source and that source's own identity, so ids never collide across sources or scopes", () => {
		const keys = [
			endoDevelopSessionKeyV1(pi(PI_ID, LAUNCH_A)),
			endoDevelopSessionKeyV1(pi(PI_ID, "b".repeat(16))),
			endoDevelopSessionKeyV1(omp(PI_ID.replace("endo.session.pi.", ""), SCOPE_1)),
			endoDevelopSessionKeyV1(omp(PI_ID, SCOPE_1)),
			endoDevelopSessionKeyV1(omp(PI_ID, SCOPE_2)),
			endoDevelopSessionKeyV1(omp(ID_A, SCOPE_1)),
		];
		expect(new Set(keys).size).toBe(keys.length);
	});
});

// ---- the store: v0 kept, explicit upgrade -----------------------------------------------------------------------------------------

describe("a v0 file is read, edited and kept as v0 until the operator upgrades it", () => {
	it("reads never rewrite it, and v0-expressible changes keep it v0 byte for byte in v0's own form", () => {
		const w = seeded();
		const v0text = asV0File(w.root);
		const read = w.store.read();
		expect(read).toMatchObject({ ok: true, format: ENDO_DEVELOP_TASKS_SCHEMA_V0, exists: true });
		const service = new DevelopWorkspaceServiceV0(w.store);
		service.read();
		service.inspect();
		service
			.forLaunch(
				{ projectId: w.projectId, launchDirectory: w.project },
				{ launchId: LAUNCH_A, attachment: "pi.default", session: null },
			)
			.view();
		expect(fileOf(w.root)).toBe(v0text);
		// Existing workflows: a status change, a selection, a Pi link and unlink. Each keeps v0.
		ok(w.store.setStatus(w.projectId, w.taskId, 2, "review", null));
		ok(w.store.linkSession(w.projectId, w.taskId, 3, pi(PI_ID, "c".repeat(16))));
		const linkId = jsonOf(w.root).tasks[0].sessions[0].linkId;
		ok(w.store.unlinkSession(w.projectId, w.taskId, 4, linkId));
		ok(w.store.selectTask(w.projectId, null));
		const after = jsonOf(w.root);
		expect(after.schemaVersion).toBe(ENDO_DEVELOP_TASKS_SCHEMA_V0);
		expect(readEndoDevelopTasksFileV0(after)).toMatchObject({ ok: true });
		expect(after.tasks[0].sessions.map((s: any) => s.launchId)).toEqual(["c".repeat(16)]);
	});

	it("an OMP reference on a v0 file is `upgrade-required`, and nothing is written", () => {
		const w = seeded();
		const v0text = asV0File(w.root);
		expect(w.store.linkSession(w.projectId, w.taskId, 2, omp(ID_A))).toEqual({ ok: false, code: "upgrade-required" });
		expect(fileOf(w.root)).toBe(v0text);
	});

	it("the upgrade is one atomic write: task revisions kept, file revision +1, then a no-op; a stale file revision is refused", () => {
		const w = seeded();
		const v0text = asV0File(w.root);
		const v0 = JSON.parse(v0text) as EndoDevelopTasksFileV0;
		expect(w.store.upgrade(v0.revision + 5)).toEqual({ ok: false, code: "stale-revision" });
		expect(fileOf(w.root)).toBe(v0text);
		const done = w.store.upgrade(v0.revision);
		expect(done).toMatchObject({
			ok: true,
			value: { from: ENDO_DEVELOP_TASKS_SCHEMA_V0, to: ENDO_DEVELOP_TASKS_SCHEMA_V1, unchanged: false },
		});
		const v1 = jsonOf(w.root);
		expect(v1.schemaVersion).toBe(ENDO_DEVELOP_TASKS_SCHEMA_V1);
		expect(v1.revision).toBe(v0.revision + 1);
		expect({ ...v1, schemaVersion: null, revision: null }).toEqual({ ...v0, schemaVersion: null, revision: null });
		const v1text = fileOf(w.root);
		expect(w.store.upgrade()).toMatchObject({ ok: true, value: { unchanged: true } });
		expect(fileOf(w.root)).toBe(v1text);
		// v1 is never written as v0: a Pi-only change on a v1 file stays v1.
		ok(w.store.setStatus(w.projectId, w.taskId, 2, "review", null));
		expect(jsonOf(w.root).schemaVersion).toBe(ENDO_DEVELOP_TASKS_SCHEMA_V1);
		ok(w.store.linkSession(w.projectId, w.taskId, 3, omp(ID_A)));
	});

	it("an upgrade after a competing write keeps that write; an expected revision from before it is refused", () => {
		const w = seeded();
		asV0File(w.root);
		const seen = jsonOf(w.root).revision;
		ok(w.store.setStatus(w.projectId, w.taskId, 2, "review", "competing"));
		expect(w.store.upgrade(seen)).toEqual({ ok: false, code: "stale-revision" });
		ok(w.store.upgrade());
		const v1 = jsonOf(w.root);
		expect(v1.tasks[0].status).toBe("review");
		expect(v1.tasks[0].history.at(-1).note).toBe("competing");
	});

	it("a crash at the replacement leaves the v0 file whole and usable; the next writer sweeps the temporary file", () => {
		const w = seeded();
		const v0text = asV0File(w.root);
		const crashing = new DevelopTasksStoreV0(w.root, {
			beforeReplace: () => {
				throw new Error("power cut");
			},
		});
		expect(crashing.upgrade()).toEqual({ ok: false, code: "storage-failed" });
		expect(fileOf(w.root)).toBe(v0text);
		expect(w.store.read()).toMatchObject({ ok: true, format: ENDO_DEVELOP_TASKS_SCHEMA_V0 });
		ok(w.store.upgrade());
		expect(jsonOf(w.root).schemaVersion).toBe(ENDO_DEVELOP_TASKS_SCHEMA_V1);
		expect(readdirSync(join(w.root, "develop")).filter((n) => n.includes(".tmp-"))).toEqual([]);
	});

	it("an unreadable, linked, oversized or unknown-version file is never upgraded and is left byte for byte", () => {
		const cases: [string, string][] = [
			["{not json", "malformed"],
			[
				JSON.stringify({ schemaVersion: "endo.develop-tasks.v9", revision: 0, projects: [], tasks: [] }),
				"unsupported-version",
			],
			[`{"schemaVersion":"endo.develop-tasks.v0","pad":"${"x".repeat(4 * 1024 * 1024)}"}`, "too-large"],
		];
		for (const [text, reason] of cases) {
			const root = fresh("bad");
			mkdirSync(join(root, "develop"), { mode: 0o700 });
			writeFileSync(join(root, "develop", "tasks.json"), text);
			expect(new DevelopTasksStoreV0(root).upgrade()).toEqual({ ok: false, code: "unreadable", reason });
			expect(fileOf(root) === text).toBe(true);
		}
		// A v0 file reached through a link: refused, and neither the link nor its target changes.
		const w = seeded();
		const v0text = asV0File(w.root);
		const target = join(fresh("elsewhere"), "tasks.json");
		renameSync(join(w.root, "develop", "tasks.json"), target);
		symlinkSync(target, join(w.root, "develop", "tasks.json"));
		expect(w.store.upgrade()).toEqual({ ok: false, code: "unreadable", reason: "unsafe-path" });
		expect(lstatSync(join(w.root, "develop", "tasks.json")).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(v0text);
		// A hard link to the file is not written through: the upgrade replaces the store's own name, never the other name's bytes.
		const h = seeded();
		const hv0 = asV0File(h.root);
		const other = join(fresh("hard"), "copy.json");
		linkSync(join(h.root, "develop", "tasks.json"), other);
		ok(h.store.upgrade());
		expect(readFileSync(other, "utf8")).toBe(hv0);
	});

	it("processes writing a v0 file while the operator upgrades it lose nothing, and exactly one upgrade is written", async () => {
		const w = seeded();
		asV0File(w.root);
		const start = jsonOf(w.root).revision;
		const worker = fileURLToPath(new URL("./fixtures/develop-tasks-writer.ts", import.meta.url));
		const go = join(w.root, "go");
		const upgrader = `const fs=require("node:fs");process.stdout.write("ready\\n");while(!fs.existsSync(${JSON.stringify(go)})){}require("node:child_process").execFileSync(process.execPath,[${JSON.stringify(CLI)},"task","upgrade",${JSON.stringify(w.root)},"--apply"],{stdio:"ignore"});`;
		const children = [
			...Array.from({ length: 4 }, (_, n) => [worker, w.root, w.projectId, String(n), "5", go]),
			["-e", upgrader],
		];
		const runs = children.map((args) => {
			const child = spawn(process.execPath, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, HOME: base },
			});
			let stderr = "";
			child.stderr.on("data", (c) => {
				stderr += String(c);
			});
			const ready = new Promise<void>((resolve, reject) => {
				child.stdout.once("data", () => resolve());
				child.once("close", () => reject(new Error(stderr)));
			});
			const done = new Promise<{ status: number | null; stderr: string }>((resolve) =>
				child.once("close", (status) => resolve({ status, stderr })),
			);
			return { ready, done };
		});
		await Promise.all(runs.map((r) => r.ready));
		writeFileSync(go, "");
		for (const run of await Promise.all(runs.map((r) => r.done))) expect(run.status, run.stderr).toBe(0);
		const after = jsonOf(w.root);
		expect(after.schemaVersion).toBe(ENDO_DEVELOP_TASKS_SCHEMA_V1);
		expect(after.tasks).toHaveLength(21);
		expect(after.revision).toBe(start + 20 + 1);
		expect(after.tasks[0].sessions).toHaveLength(1);
	}, 60_000);

	it("a missing file is created as v1", () => {
		const w = seeded();
		expect(jsonOf(w.root).schemaVersion).toBe(ENDO_DEVELOP_TASKS_SCHEMA_V1);
	});
});

describe("source-aware links in the store", () => {
	it("repeats are idempotent per association; scopes and sources stay apart; relinking after unlinking makes a new reference", () => {
		const w = seeded();
		let rev = 2;
		const link = (ref: Parameters<DevelopTasksStoreV0["linkSession"]>[3]) => {
			const t = ok(w.store.linkSession(w.projectId, w.taskId, rev, ref));
			rev = t.revision;
			return t;
		};
		link(omp(ID_A, SCOPE_1));
		const bytes = fileOf(w.root);
		link(omp(ID_A, SCOPE_1));
		expect(fileOf(w.root)).toBe(bytes);
		link(omp(ID_A, SCOPE_2));
		// An OMP id spelled exactly like the Pi reference's id, beside it: a different association.
		const t = link(omp(PI_ID, SCOPE_1));
		expect(t.sessions.map((s) => [s.source, s.sessionId])).toEqual([
			["pi-live", PI_ID],
			["omp-saved", ID_A],
			["omp-saved", ID_A],
			["omp-saved", PI_ID],
		]);
		const first = t.sessions[1]!.linkId;
		rev = ok(w.store.unlinkSession(w.projectId, w.taskId, rev, first)).revision;
		const again = link(omp(ID_A, SCOPE_1));
		expect(
			again.sessions.filter((s) => s.source === "omp-saved" && s.sessionId === ID_A && s.scope === SCOPE_1),
		).toHaveLength(1);
		expect(again.sessions.map((s) => s.linkId)).not.toContain(first);
		expect(w.store.linkSession(w.projectId, w.taskId, rev - 1, omp(ID_B))).toEqual({
			ok: false,
			code: "stale-revision",
		});
	});
});

// ---- the service: who can make which reference ---------------------------------------------------------------------------------

describe("authority: a launch makes only live references, the operator scope only observed ones", () => {
	const hostOf = (source: string, sessionId: string): DevelopLaunchHostV0 => ({
		launchId: LAUNCH_A,
		attachment: "pi.default",
		session: { source, current: () => ({ sessionId }) },
		aliasOf: (id) => `alias:${id.length}`,
	});

	it("a host speaking for omp-saved can neither link nor make anything current, and writes nothing", () => {
		const w = seeded();
		const service = new DevelopWorkspaceServiceV0(w.store);
		ok(
			service.linkObservedSession(w.projectId, w.taskId, 2, {
				source: "omp-saved",
				sessionId: ID_A,
				scope: SCOPE_1,
				format: 3,
			}),
		);
		const before = fileOf(w.root);
		const scope = service.forLaunch(
			{ projectId: w.projectId, launchDirectory: w.project },
			hostOf("omp-saved", ID_A),
		);
		expect(scope.view().linkable).toBe(false);
		expect(scope.linkCurrentSession(w.taskId, 3)).toEqual({ ok: false, code: "unsupported-source" });
		expect(scope.view().tasks[0]!.sessions.map((s) => s.relation)).toEqual(["historical", "saved"]);
		expect(fileOf(w.root)).toBe(before);
		// The launch scope has no observed-link operation at all.
		expect("linkObservedSession" in scope).toBe(false);
	});

	it("an OMP reference is `saved` even when a Pi host in the same launch reports the very same id string", () => {
		const w = seeded();
		const service = new DevelopWorkspaceServiceV0(w.store);
		ok(
			service.linkObservedSession(w.projectId, w.taskId, 2, {
				source: "omp-saved",
				sessionId: PI_ID,
				scope: SCOPE_1,
				format: 3,
			}),
		);
		const scope = service.forLaunch({ projectId: w.projectId, launchDirectory: w.project }, hostOf("pi-live", PI_ID));
		expect(scope.view().tasks[0]!.sessions.map((s) => [s.source, s.relation])).toEqual([
			["pi-live", "current"],
			["omp-saved", "saved"],
		]);
	});

	it("the operator scope refuses a live source, a forged shape or a Studio selector", () => {
		const w = seeded();
		const service = new DevelopWorkspaceServiceV0(w.store);
		const before = fileOf(w.root);
		const tries: [unknown, string][] = [
			[{ source: "pi-live", sessionId: PI_ID, scope: SCOPE_1, format: 3 }, "unsupported-source"],
			[{ source: "codex-live", sessionId: ID_A, scope: SCOPE_1, format: 3 }, "unsupported-source"],
			[{ source: "omp-saved", sessionId: `o1-${"a".repeat(32)}`, scope: SCOPE_1, format: 3 }, "bad-request"],
			[{ source: "omp-saved", sessionId: ID_A, scope: "/home/x/.omp/agent/sessions", format: 3 }, "bad-request"],
			[{ source: "omp-saved", sessionId: ID_A, scope: SCOPE_1, format: 4 }, "bad-request"],
		];
		for (const [observed, code] of tries)
			expect(service.linkObservedSession(w.projectId, w.taskId, 2, observed as never)).toEqual({ ok: false, code });
		expect(fileOf(w.root)).toBe(before);
	});

	it("the workbench route accepts no session description: a forged body is refused and nothing is written", () => {
		const w = seeded();
		const service = new DevelopWorkspaceServiceV0(w.store);
		const routes = new EndoWorkspaceRoutesV0(
			service.forLaunch({ projectId: w.projectId, launchDirectory: w.project }, hostOf("pi-live", PI_ID)),
		);
		const before = fileOf(w.root);
		for (const body of [
			{ taskId: w.taskId, expectedRevision: 2, source: "omp-saved" },
			{ taskId: w.taskId, expectedRevision: 2, sessionId: ID_A },
			{ taskId: w.taskId, expectedRevision: 2, scope: SCOPE_1 },
		])
			expect(routes.handle(["workspace", "tasks", "link-session"], "POST", "", body).status).toBe(400);
		for (const route of ["link-observed", "link-omp", "upgrade"])
			expect(routes.handle(["workspace", "tasks", route], "POST", "", { taskId: w.taskId }).status).toBe(404);
		expect(fileOf(w.root)).toBe(before);
	});

	it("the page is given a label, never the OMP id, the scope digest or a path, and its gate refuses an OMP reference that claims more", () => {
		const w = seeded();
		const service = new DevelopWorkspaceServiceV0(w.store);
		const secretId = `${CANARY}-id-91ab`;
		ok(
			service.linkObservedSession(w.projectId, w.taskId, 2, {
				source: "omp-saved",
				sessionId: secretId,
				scope: SCOPE_1,
				format: 3,
			}),
		);
		const view = service
			.forLaunch({ projectId: w.projectId, launchDirectory: w.project }, hostOf("pi-live", PI_ID))
			.view();
		const body = JSON.stringify(view);
		expect(body).not.toContain(CANARY);
		expect(body).not.toContain(SCOPE_1);
		expect(body).not.toContain(PI_ID);
		expect(readWorkspace(view)).not.toBeNull();
		const ompRef = view.tasks[0]!.sessions[1]!;
		expect(ompRef).toEqual({
			linkId: expect.any(String),
			source: "omp-saved",
			alias: "omp -id-91ab",
			scopeLabel: "11111111",
			linkedAtMs: 1_000,
			linkedBy: "operator",
			via: "cli",
			relation: "saved",
		});
		const forge = (patch: Record<string, unknown>) => {
			const copy = structuredClone(view);
			Object.assign(copy.tasks[0]!.sessions[1]!, patch);
			return readWorkspace(copy);
		};
		expect(forge({ relation: "current" })).toBeNull();
		expect(forge({ relation: "historical" })).toBeNull();
		expect(forge({ launchId: LAUNCH_A })).toBeNull();
		expect(forge({ attachment: "pi.default" })).toBeNull();
		expect(forge({ sessionId: secretId })).toBeNull();
		expect(readWorkspace({ ...view, schemaVersion: "endo.develop-workspace.v0" })).toBeNull();
		// Two different OMP ids ending alike: neither gets a label, so a label never stands for two sessions.
		const lookalike = `0${secretId}`;
		ok(
			service.linkObservedSession(w.projectId, w.taskId, 3, {
				source: "omp-saved",
				sessionId: lookalike,
				scope: SCOPE_2,
				format: 3,
			}),
		);
		const both = service
			.forLaunch({ projectId: w.projectId, launchDirectory: w.project }, hostOf("pi-live", PI_ID))
			.view();
		expect(both.tasks[0]!.sessions.filter((s) => s.source === "omp-saved").map((s) => s.alias)).toEqual([null, null]);
	});
});

// ---- the observer's resolution ------------------------------------------------------------------------------------------------------

describe("resolving an OMP id: exactly one readable carrier, every file read", () => {
	const resolve = (root: string, id: string) => new OmpSavedSessionObserverV0({ root, key: OTHER_KEY }).resolve(id);

	it("establishes one, refuses duplicates, a missing or malformed id, and a file it could not read", () => {
		const root = fresh("omp");
		mkdirSync(join(root, "-work-demo"));
		writeFileSync(join(root, "-work-demo", `a_${ID_A}.jsonl`), session(ID_A));
		expect(resolve(root, ID_A)).toEqual({
			status: "established",
			sessionId: ID_A,
			scope: ompScopeOfRootV0(root),
			format: 3,
		});
		expect(resolve(root, ID_B)).toEqual({ status: "not-found", unread: 0 });
		// A copy carrying the same id: neither is the session.
		writeFileSync(join(root, "-work-demo", "copy.jsonl"), session(ID_A));
		expect(resolve(root, ID_A)).toEqual({ status: "duplicate", files: 2 });
		rmSync(join(root, "-work-demo", "copy.jsonl"));
		// A header whose id is not an id is no carrier; a file of another format might be one, so a single carrier is not established.
		writeFileSync(join(root, "bad-id.jsonl"), header("../../etc"));
		expect(resolve(root, ID_A).status).toBe("established");
		writeFileSync(join(root, "v4.jsonl"), `${JSON.stringify({ type: "session", version: 4, id: ID_A })}\n`);
		expect(resolve(root, ID_A)).toEqual({ status: "uncertain", unread: 1 });
		rmSync(join(root, "v4.jsonl"));
		const locked = join(root, "locked.jsonl");
		writeFileSync(locked, session(ID_B));
		chmodSync(locked, 0o000);
		if (process.getuid?.() !== 0) expect(resolve(root, ID_A)).toEqual({ status: "uncertain", unread: 1 });
		rmSync(locked);
		expect(resolve(root, ID_A).status).toBe("established");
		// A copy below the depth bound, or behind a link, is never read, so a single carrier is not established.
		mkdirSync(join(root, "a", "b", "c"), { recursive: true });
		writeFileSync(join(root, "a", "b", "c", "deep.jsonl"), session(ID_A));
		expect(resolve(root, ID_A)).toEqual({ status: "uncertain", unread: 1 });
		rmSync(join(root, "a"), { recursive: true });
		const outside = fresh("omp-outside");
		writeFileSync(join(outside, "x.jsonl"), session(ID_A));
		symlinkSync(join(outside, "x.jsonl"), join(root, "linked.jsonl"));
		expect(resolve(root, ID_A)).toEqual({ status: "uncertain", unread: 1 });
		rmSync(join(root, "linked.jsonl"));
		expect(resolve(root, ID_A).status).toBe("established");
	});

	it("a file replaced by another between two choices is resolved as it now is, never by its old name", () => {
		const root = fresh("omp-replaced");
		writeFileSync(join(root, "s.jsonl"), session(ID_A));
		expect(resolve(root, ID_A).status).toBe("established");
		writeFileSync(join(root, "s.new"), session(ID_B));
		renameSync(join(root, "s.new"), join(root, "s.jsonl"));
		expect(resolve(root, ID_A)).toEqual({ status: "not-found", unread: 0 });
		expect(resolve(root, ID_B).status).toBe("established");
	});

	it("two directories holding one id are two scopes, and a scope is a digest, not the path", () => {
		const one = fresh("omp-one");
		const two = fresh("omp-two");
		writeFileSync(join(one, "s.jsonl"), session(ID_A));
		writeFileSync(join(two, "s.jsonl"), session(ID_A));
		const a = resolve(one, ID_A);
		const b = resolve(two, ID_A);
		if (a.status !== "established" || b.status !== "established") throw new Error("not established");
		expect(a.scope).not.toBe(b.scope);
		expect(a.scope).toMatch(/^omp-dir\.[0-9a-f]{32}$/);
		expect(a.scope).not.toContain("omp-one");
		expect(resolve(one, ID_A)).toEqual(a);
	});
});

// ---- the CLI, end to end --------------------------------------------------------------------------------------------------------

describe("endo task link | show | unlink | upgrade", () => {
	const endo = (args: string[], env: Record<string, string> = {}) =>
		spawnSync(process.execPath, [CLI, ...args], {
			cwd: base,
			encoding: "utf8",
			env: { ...process.env, HOME: base, ...env },
		});
	const json = (text: string) => JSON.parse(text) as Record<string, any>;

	function setup() {
		const root = fresh("cli-root");
		const project = fresh("cli-project");
		const sessions = fresh("cli-omp");
		mkdirSync(join(sessions, "-work-demo"));
		writeFileSync(join(sessions, "-work-demo", `2026_${ID_A}.jsonl`), session(ID_A));
		writeFileSync(join(sessions, "-work-demo", `2026_${ID_B}.jsonl`), session(ID_B, { exit: false }));
		const added = endo(["project", "add", root, "--name", "demo", "--path", project]);
		const projectId = json(added.stdout).project.id as string;
		const task = endo(["task", "add", root, "--project", projectId, "--title", "Parser"]);
		const taskId = json(task.stdout).task.id as string;
		return { root, project, sessions, projectId, taskId };
	}

	it("links a real saved session found exactly once, shows it, keeps it when the file goes, and never touches OMP's files", () => {
		const w = setup();
		// A fake `omp` first on PATH: if anything ran it, it would leave a mark.
		const bin = fresh("bin");
		const mark = join(base, `omp-ran-${made}`);
		writeFileSync(join(bin, "omp"), `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
		const env = { PATH: `${bin}:${process.env.PATH}` };
		const before = manifest(w.sessions);
		const linkArgs = [
			"task",
			"link",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--source",
			"omp-saved",
			"--session",
			ID_A,
			"--omp-sessions",
			w.sessions,
		];
		const linked = endo(linkArgs, env);
		expect(linked.status, linked.stderr).toBe(0);
		const out = json(linked.stdout);
		expect(out.linked).toBe("new");
		expect(out.reference).toMatchObject({
			source: "omp-saved",
			sessionId: ID_A,
			scope: ompScopeOfRootV0(w.sessions),
			observedFormat: 3,
			via: "cli",
		});
		expect(linked.stderr).toMatch(/cannot resume, prompt, steer, queue, stop or select/);
		// Again: the same association, nothing new.
		const again = endo(linkArgs, env);
		expect(json(again.stdout).linked).toBe("already");
		expect(json(again.stdout).task.revision).toBe(out.task.revision);
		// The task file holds the id, the scope digest and the format: no path, no title, no transcript.
		const stored = fileOf(w.root);
		expect(stored).not.toContain(CANARY);
		expect(stored).not.toContain(w.sessions);
		expect(stored).not.toContain(".jsonl");
		// show, with the directory: found; then the file goes and the reference stays, reported as not found.
		const shown = endo([
			"task",
			"show",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--omp-sessions",
			w.sessions,
		]);
		expect(json(shown.stdout).task.references.map((r: any) => r.observedNow)).toEqual(["established"]);
		rmSync(join(w.sessions, "-work-demo", `2026_${ID_A}.jsonl`));
		const gone = endo([
			"task",
			"show",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--omp-sessions",
			w.sessions,
		]);
		expect(json(gone.stdout).task.references).toMatchObject([{ sessionId: ID_A, observedNow: "not-found" }]);
		const other = fresh("cli-omp-other");
		const elsewhere = endo([
			"task",
			"show",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--omp-sessions",
			other,
		]);
		expect(json(elsewhere.stdout).task.references[0].observedNow).toBe("other-directory");
		expect(existsSync(mark)).toBe(false);
		// Only the file the test itself removed changed in OMP's directory.
		const after = manifest(w.sessions);
		delete before[join("-work-demo", `2026_${ID_A}.jsonl`)];
		delete before["-work-demo"];
		delete after["-work-demo"];
		expect(after).toEqual(before);
		// Unlink, by its link id.
		const unlinked = endo([
			"task",
			"unlink",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--link",
			out.reference.linkId,
		]);
		expect(unlinked.status, unlinked.stderr).toBe(0);
		expect(json(unlinked.stdout).task.sessionReferences).toBe(0);
	});

	it("refuses what is not proof: a Studio selector, a live source, an unseen id, a duplicate, an overlapping store", () => {
		const w = setup();
		const link = (session: string, extra: string[] = [], dir = w.sessions, root = w.root) =>
			endo([
				"task",
				"link",
				root,
				"--project",
				w.projectId,
				"--task",
				w.taskId,
				"--source",
				"omp-saved",
				"--session",
				session,
				"--omp-sessions",
				dir,
				...extra,
			]);
		const before = fileOf(w.root);
		const selector = link(`o1-${"a".repeat(32)}`);
		expect([selector.status, selector.stderr]).toEqual([1, expect.stringMatching(/Studio selector/)]);
		const live = endo([
			"task",
			"link",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--source",
			"pi-live",
			"--session",
			PI_ID,
		]);
		expect(live.stderr).toMatch(/linked only by the workbench/);
		const unknown = endo([
			"task",
			"link",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--source",
			"codex",
			"--session",
			ID_A,
			"--omp-sessions",
			w.sessions,
		]);
		expect(unknown.stderr).toMatch(/--source must be omp-saved/);
		expect(link("019a0000-0000-7000-8000-0000000000ff").stderr).toMatch(/no readable saved session/);
		writeFileSync(join(w.sessions, "copy.jsonl"), session(ID_A));
		expect(link(ID_A).stderr).toMatch(/2 saved files/);
		rmSync(join(w.sessions, "copy.jsonl"));
		// A store that does not exist yet, reached through a link into OMP's directory: refused before anything is made.
		const omplink = join(fresh("via"), "omp");
		symlinkSync(w.sessions, omplink);
		const ompBefore = manifest(w.sessions);
		expect(link(ID_A, ["--revision", "0"], w.sessions, join(omplink, "newstore")).stderr).toMatch(/no task file yet/);
		expect(manifest(w.sessions)).toEqual(ompBefore);
		// An existing store inside OMP's directory: the overlap is refused.
		const inside = join(w.sessions, "store");
		const p2 = json(endo(["project", "add", inside, "--name", "x", "--path", w.project]).stdout).project.id as string;
		const t2 = json(endo(["task", "add", inside, "--project", p2, "--title", "x"]).stdout).task.id as string;
		const overlapping = endo([
			"task",
			"link",
			inside,
			"--project",
			p2,
			"--task",
			t2,
			"--source",
			"omp-saved",
			"--session",
			ID_A,
			"--omp-sessions",
			w.sessions,
		]);
		expect(overlapping.stderr).toMatch(/overlap/);
		rmSync(inside, { recursive: true });
		expect(link(ID_A, ["--revision", "7"]).stderr).toMatch(/changed since that revision/);
		expect(fileOf(w.root)).toBe(before);
	});

	it("upgrade is a dry run until --apply; a v0 store links Pi as before and refuses OMP with the way forward", () => {
		const w = setup();
		const v0text = asV0File(w.root);
		const dry = endo(["task", "upgrade", w.root]);
		expect(dry.status, dry.stderr).toBe(0);
		expect(json(dry.stdout)).toMatchObject({
			file: { format: ENDO_DEVELOP_TASKS_SCHEMA_V0, tasks: 1 },
			upgrade: "available",
		});
		expect(dry.stderr).toMatch(/dry run: nothing was written/);
		expect(json(endo(["project", "list", w.root]).stdout).format).toBe(ENDO_DEVELOP_TASKS_SCHEMA_V0);
		const refused = endo([
			"task",
			"link",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--source",
			"omp-saved",
			"--session",
			ID_A,
			"--omp-sessions",
			w.sessions,
		]);
		expect([refused.status, refused.stderr]).toEqual([1, expect.stringMatching(/endo task upgrade --apply/)]);
		const status = endo([
			"task",
			"status",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--to",
			"in-progress",
		]);
		expect(status.status, status.stderr).toBe(0);
		expect(jsonOf(w.root).schemaVersion).toBe(ENDO_DEVELOP_TASKS_SCHEMA_V0);
		expect(fileOf(w.root)).not.toBe(v0text);
		const applied = endo(["task", "upgrade", w.root, "--apply"]);
		expect(json(applied.stdout)).toMatchObject({
			upgrade: { from: ENDO_DEVELOP_TASKS_SCHEMA_V0, unchanged: false },
			file: { format: ENDO_DEVELOP_TASKS_SCHEMA_V1 },
		});
		expect(json(endo(["task", "upgrade", w.root, "--apply"]).stdout).upgrade.unchanged).toBe(true);
		const linked = endo([
			"task",
			"link",
			w.root,
			"--project",
			w.projectId,
			"--task",
			w.taskId,
			"--source",
			"omp-saved",
			"--session",
			ID_A,
			"--omp-sessions",
			w.sessions,
		]);
		expect(linked.status, linked.stderr).toBe(0);
	});
});
