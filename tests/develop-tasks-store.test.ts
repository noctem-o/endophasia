// The DEVELOP task store (storage/develop-tasks.ts): what survives a restart, what it refuses, and what a crash, a second writer, a link
// or a damaged file cannot make it do. Real files in a temporary store root; synthetic text only.
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENDO_DEVELOP_TASK_LIMITS_V0,
	endoDevelopNextStatusesV0,
	validateEndoDevelopTasksFileV0,
} from "../protocol/develop-tasks.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";

const roots: string[] = [];
const fresh = (): string => {
	const root = mkdtempSync(join(tmpdir(), "endo-tasks-"));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** What is in develop/ besides the writer lock, which leaves its highest number behind, marked released. */
const developFiles = (root: string) =>
	readdirSync(join(root, "develop")).filter((name) => !/^tasks\.lock\.[1-9][0-9]*$/.test(name));
const lockFiles = (root: string) => readdirSync(join(root, "develop")).filter((name) => name.startsWith("tasks.lock"));
const registered = (root: string) => {
	const store = new DevelopTasksStoreV0(root);
	const project = store.registerProject({ name: "demo", path: "/work/demo", observedGitRoot: "/work/demo" });
	if (!project.ok) throw new Error("registration failed");
	return { store, project: project.value };
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(`refused: ${r.code}`);
	return r.value;
};
const bytesOf = (root: string) => readFileSync(join(root, "develop", "tasks.json"));

describe("tasks survive a restart and keep their words", () => {
	it("creates, edits and reads across a new store object (a restart)", () => {
		const root = fresh();
		const { store, project } = registered(root);
		const task = ok(
			store.createTask(project.id, {
				title: "Fix the parser",
				description: "It drops the last token.\nSee the fixture.",
				acceptance: "All parser tests pass.",
			}),
		);
		ok(store.updateTask(project.id, task.id, task.revision, { acceptance: "Parser tests pass; no new warnings." }));
		const later = new DevelopTasksStoreV0(root).read();
		expect(later.ok).toBe(true);
		if (!later.ok) return;
		expect(later.file.projects.map((p) => [p.name, p.path])).toEqual([["demo", "/work/demo"]]);
		const [read] = later.file.tasks;
		expect(read).toMatchObject({
			title: "Fix the parser",
			description: "It drops the last token.\nSee the fixture.",
			acceptance: "Parser tests pass; no new warnings.",
			status: "open",
			revision: 1,
			sessions: [],
		});
		expect(read?.history).toEqual([{ atMs: expect.any(Number), from: null, to: "open", note: null }]);
	});

	it("writes owner-only files in an owner-only directory, and nothing else in the store", () => {
		const root = fresh();
		mkdirSync(join(root, "events"));
		writeFileSync(join(root, "events", "events.log"), "evidence");
		registered(root);
		expect(statSync(join(root, "develop")).mode & 0o777).toBe(0o700);
		expect(statSync(join(root, "develop", "tasks.json")).mode & 0o777).toBe(0o600);
		expect(developFiles(root)).toEqual(["tasks.json"]);
		expect(readFileSync(join(root, "events", "events.log"), "utf8")).toBe("evidence");
		expect(readdirSync(root).sort()).toEqual(["develop", "events"]);
	});

	it("registers the first project under a store root that does not exist yet", () => {
		const parent = fresh();
		const root = join(parent, "not", "yet", "there");
		const { store } = registered(root);
		expect(statSync(join(root, "develop")).mode & 0o777).toBe(0o700);
		expect(readdirSync(root)).toEqual(["develop"]);
		const read = store.read();
		expect(read.ok && read.file.projects).toHaveLength(1);
	});

	it("still refuses a develop directory that is a link, even when the root had to be made", () => {
		const root = fresh();
		const elsewhere = fresh();
		symlinkSync(elsewhere, join(root, "develop"));
		const attempt = new DevelopTasksStoreV0(root).registerProject({
			name: "x",
			path: "/work/x",
			observedGitRoot: null,
		});
		expect(attempt.ok).toBe(false);
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	it("a read creates nothing", () => {
		const root = fresh();
		const read = new DevelopTasksStoreV0(root).read();
		expect(read).toMatchObject({ ok: true, exists: false });
		expect(readdirSync(root)).toEqual([]);
	});

	it("registers a directory once, and refuses a second project with the same path", () => {
		const root = fresh();
		const { store } = registered(root);
		expect(store.registerProject({ name: "again", path: "/work/demo", observedGitRoot: null })).toMatchObject({
			ok: false,
			code: "duplicate",
		});
		expect(store.registerProject({ name: "relative", path: "work/x", observedGitRoot: null })).toMatchObject({
			ok: false,
			code: "bad-request",
		});
	});
});

describe("status is the operator's, in small reversible steps", () => {
	it("moves open → in-progress → review → done and back by explicit reopening", () => {
		const { store, project } = registered(fresh());
		let task = ok(store.createTask(project.id, { title: "t" }));
		for (const to of ["in-progress", "review", "done", "open"] as const) {
			task = ok(
				store.setStatus(project.id, task.id, task.revision, to, to === "done" ? "merged by hand" : undefined),
			);
			expect(task.status).toBe(to);
		}
		expect(task.history.map((h) => [h.from, h.to, h.note])).toEqual([
			[null, "open", null],
			["open", "in-progress", null],
			["in-progress", "review", null],
			["review", "done", "merged by hand"],
			["done", "open", null],
		]);
	});

	it("refuses a status that is not a next step, and every unknown one", () => {
		const { store, project } = registered(fresh());
		const task = ok(store.createTask(project.id, { title: "t" }));
		for (const to of ["review", "done"] as const)
			expect(store.setStatus(project.id, task.id, task.revision, to, null)).toMatchObject({
				ok: false,
				code: "invalid-transition",
			});
		for (const to of ["finished", "", 3, null, "__proto__"])
			expect(store.setStatus(project.id, task.id, task.revision, to, null)).toMatchObject({
				ok: false,
				code: "bad-request",
			});
		// Only a declared table moves a task, and done is reachable only from review.
		expect(endoDevelopNextStatusesV0("done")).toEqual(["open"]);
		expect(
			(["open", "in-progress", "blocked"] as const).filter((s) => endoDevelopNextStatusesV0(s).includes("done")),
		).toEqual([]);
	});

	it("linking the same session in the same launch again changes nothing", () => {
		const root = fresh();
		const { store, project } = registered(root);
		const task = ok(store.createTask(project.id, { title: "t" }));
		const ref = {
			source: "pi-live",
			sessionId: "endo.session.pi.s1",
			attachment: "pi.default",
			launchId: "1".repeat(16),
			linkedBy: "operator",
			via: "workbench",
		} as const;
		const first = ok(store.linkSession(project.id, task.id, task.revision, ref));
		const bytes = bytesOf(root);
		const again = ok(store.linkSession(project.id, task.id, first.revision, ref));
		expect(again.sessions).toHaveLength(1);
		expect(bytesOf(root).equals(bytes)).toBe(true);
		// A different launch is a different claim.
		const other = ok(store.linkSession(project.id, task.id, first.revision, { ...ref, launchId: "2".repeat(16) }));
		expect(other.sessions.map((s) => (s.source === "pi-live" ? s.launchId : null))).toEqual([
			"1".repeat(16),
			"2".repeat(16),
		]);
	});

	it("does not edit the status through an edit", () => {
		const { store, project } = registered(fresh());
		const task = ok(store.createTask(project.id, { title: "t" }));
		const edited = ok(store.updateTask(project.id, task.id, task.revision, { title: "u", status: "done" } as never));
		expect(edited.status).toBe("open");
	});

	it("keeps the newest status changes when the history is full", () => {
		const { store, project } = registered(fresh());
		let task = ok(store.createTask(project.id, { title: "t" }));
		for (let i = 0; i < ENDO_DEVELOP_TASK_LIMITS_V0.maxHistory + 10; i += 1)
			task = ok(
				store.setStatus(project.id, task.id, task.revision, task.status === "open" ? "blocked" : "open", `n${i}`),
			);
		expect(task.history).toHaveLength(ENDO_DEVELOP_TASK_LIMITS_V0.maxHistory);
		expect(task.history.at(-1)?.note).toBe(`n${ENDO_DEVELOP_TASK_LIMITS_V0.maxHistory + 9}`);
	});
});

describe("a stale edit is refused, never merged", () => {
	it("two views of one task: the second edit loses visibly", () => {
		const { store, project } = registered(fresh());
		const task = ok(store.createTask(project.id, { title: "t" }));
		ok(store.updateTask(project.id, task.id, task.revision, { title: "first" }));
		expect(store.updateTask(project.id, task.id, task.revision, { title: "second" })).toMatchObject({
			ok: false,
			code: "stale-revision",
		});
		expect(store.setStatus(project.id, task.id, task.revision, "in-progress", null)).toMatchObject({
			ok: false,
			code: "stale-revision",
		});
		const read = store.read();
		expect(read.ok && read.file.tasks[0]?.title).toBe("first");
	});

	it("editing one task does not stale another", () => {
		const { store, project } = registered(fresh());
		const a = ok(store.createTask(project.id, { title: "a" }));
		const b = ok(store.createTask(project.id, { title: "b" }));
		ok(store.updateTask(project.id, a.id, a.revision, { title: "a2" }));
		expect(store.updateTask(project.id, b.id, b.revision, { title: "b2" }).ok).toBe(true);
	});

	it("a task is reached only through its own project", () => {
		const root = fresh();
		const { store, project } = registered(root);
		const other = ok(store.registerProject({ name: "other", path: "/work/other", observedGitRoot: null }));
		const task = ok(store.createTask(project.id, { title: "t" }));
		expect(store.updateTask(other.id, task.id, 0, { title: "x" })).toMatchObject({ ok: false, code: "not-found" });
		expect(store.selectTask(other.id, task.id)).toMatchObject({ ok: false, code: "not-found" });
	});

	it("many processes writing at once lose nothing and corrupt nothing", async () => {
		const root = fresh();
		const { project } = registered(root);
		const worker = fileURLToPath(new URL("./fixtures/develop-tasks-writer.ts", import.meta.url));
		const go = join(root, "go");
		// Six real processes, started together: each is loaded and waiting before any is released, so the writes truly contend for the lock.
		const runs = Array.from({ length: 6 }, (_, n) => {
			const child = spawn(process.execPath, [worker, root, project.id, String(n), "8", go], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const ready = new Promise<void>((resolve, reject) => {
				child.stdout.once("data", () => resolve());
				child.once("error", reject);
				child.once("close", () => reject(new Error(`writer ${n} ended before it was ready: ${stderr}`)));
			});
			const done = new Promise<{ status: number | null; stderr: string }>((resolve) => {
				child.once("close", (status) => resolve({ status, stderr }));
			});
			return { ready, done };
		});
		await Promise.all(runs.map((run) => run.ready));
		writeFileSync(go, "");
		for (const run of await Promise.all(runs.map((r) => r.done))) expect(run.status, run.stderr).toBe(0);
		rmSync(go);
		const read = new DevelopTasksStoreV0(root).read();
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.file.tasks).toHaveLength(48);
		expect(new Set(read.file.tasks.map((t) => t.title)).size).toBe(48);
		expect(read.file.revision).toBe(49);
		expect(developFiles(root)).toEqual(["tasks.json"]);
		// However many writers took turns, one lock file is left: the highest number, released.
		expect(lockFiles(root)).toHaveLength(1);
	}, 60_000);
});

describe("interrupted writes and storage errors", () => {
	it("a crash before the file is replaced leaves the old file and sweeps the leftover next time", () => {
		const root = fresh();
		const { project } = registered(root);
		const before = bytesOf(root);
		const crashing = new DevelopTasksStoreV0(root, {
			beforeReplace: () => {
				throw new Error("power lost");
			},
		});
		expect(crashing.createTask(project.id, { title: "lost" })).toMatchObject({ ok: false, code: "storage-failed" });
		expect(bytesOf(root).equals(before)).toBe(true);
		expect(developFiles(root)).toEqual(["tasks.json"]);
		// A real crash cannot clean up after itself: a temporary file a dead writer left is removed by the next writer, never read.
		const leftover = join(root, "develop", "tasks.json.tmp-99999-0123456789ab");
		writeFileSync(leftover, '{"half":');
		const store = new DevelopTasksStoreV0(root);
		expect(store.read().ok).toBe(true);
		ok(store.createTask(project.id, { title: "kept" }));
		expect(existsSync(leftover)).toBe(false);
		const read = store.read();
		expect(read.ok && read.file.tasks.map((t) => t.title)).toEqual(["kept"]);
	});

	it("a directory that cannot be written is a refusal, not a partial write", () => {
		if (process.getuid?.() === 0) return;
		const root = fresh();
		const { project } = registered(root);
		const before = bytesOf(root);
		chmodSync(join(root, "develop"), 0o500);
		try {
			expect(new DevelopTasksStoreV0(root).createTask(project.id, { title: "x" }).ok).toBe(false);
		} finally {
			chmodSync(join(root, "develop"), 0o700);
		}
		expect(bytesOf(root).equals(before)).toBe(true);
	});

	it("a lock held by a live process makes a writer answer busy; a lock of a dead process is superseded", () => {
		const root = fresh();
		const { project } = registered(root);
		// Every write leaves exactly one lock file behind, the highest number, marked released.
		const [rest] = lockFiles(root);
		expect(lockFiles(root)).toHaveLength(1);
		const n = Number(rest!.slice("tasks.lock.".length));
		expect(JSON.parse(readFileSync(join(root, "develop", rest!), "utf8"))).toEqual({ released: true });
		const lock = join(root, "develop", `tasks.lock.${n + 1}`);
		writeFileSync(lock, `${JSON.stringify({ pid: process.ppid, at: "now" })}\n`);
		expect(new DevelopTasksStoreV0(root, { lockWaitMs: 60 }).createTask(project.id, { title: "x" })).toMatchObject({
			ok: false,
			code: "busy",
		});
		// A dead lock BELOW the highest number is not the lock: the highest one still holds.
		writeFileSync(join(root, "develop", `tasks.lock.${n}`), `${JSON.stringify({ released: true })}\n`);
		expect(new DevelopTasksStoreV0(root, { lockWaitMs: 60 }).createTask(project.id, { title: "x" })).toMatchObject({
			ok: false,
			code: "busy",
		});
		const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
			encoding: "utf8",
		});
		writeFileSync(lock, `${JSON.stringify({ pid: Number(dead.stdout), at: "then" })}\n`);
		expect(new DevelopTasksStoreV0(root, { lockWaitMs: 60 }).createTask(project.id, { title: "y" }).ok).toBe(true);
		// The dead holder's lock is superseded by the next number, never removed to be replaced; the lower numbers are gone.
		expect(existsSync(lock)).toBe(false);
		expect(lockFiles(root)).toEqual([`tasks.lock.${n + 2}`]);
	});

	it("a writer that took a lock is never displaced by a slow one that judged the old holder dead", () => {
		const root = fresh();
		const { project } = registered(root);
		const [rest] = lockFiles(root);
		const n = Number(rest!.slice("tasks.lock.".length));
		const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
			encoding: "utf8",
		});
		// Holder A died holding n+1. B supersedes it with n+2 and is working (alive: the test's parent). A slow contender C that saw n+1
		// dead may only try n+2, which exists; it must find the lock held and wait, not remove or move B's lock.
		writeFileSync(
			join(root, "develop", `tasks.lock.${n + 1}`),
			`${JSON.stringify({ pid: Number(dead.stdout), at: "then" })}\n`,
		);
		const b = join(root, "develop", `tasks.lock.${n + 2}`);
		writeFileSync(b, `${JSON.stringify({ pid: process.ppid, at: "now" })}\n`);
		const before = readFileSync(b, "utf8");
		const c = new DevelopTasksStoreV0(root, { lockWaitMs: 80 }).createTask(project.id, { title: "slow" });
		expect(c).toMatchObject({ ok: false, code: "busy" });
		expect(readFileSync(b, "utf8")).toBe(before);
		const read = new DevelopTasksStoreV0(root).read();
		expect(read.ok && read.file.tasks).toHaveLength(0);
	});

	it("leaves a lock's crashed temporary file for the next writer to sweep once it is old, not while it may be a live one's", () => {
		const root = fresh();
		const { project } = registered(root);
		const fresh_ = join(root, "develop", "tasks.lock.tmp-99999-0123456789ab");
		const old = join(root, "develop", "tasks.lock.tmp-99998-0123456789ab");
		writeFileSync(fresh_, "{}");
		writeFileSync(old, "{}");
		const longAgo = new Date(Date.now() - 120_000);
		utimesSync(old, longAgo, longAgo);
		ok(new DevelopTasksStoreV0(root).createTask(project.id, { title: "t" }));
		expect(existsSync(fresh_)).toBe(true);
		expect(existsSync(old)).toBe(false);
	});
});

describe("a damaged, foreign or hostile file is unreadable, reported, and left exactly as found", () => {
	const unreadable = (root: string, reason: string) => {
		const before = bytesOf(root);
		const store = new DevelopTasksStoreV0(root);
		expect(store.read()).toEqual({ ok: false, reason });
		expect(store.createTask("endo.project.00000000000000000000000000000000", { title: "x" })).toMatchObject({
			ok: false,
			code: "unreadable",
			reason,
		});
		expect(store.registerProject({ name: "n", path: "/x", observedGitRoot: null })).toMatchObject({
			ok: false,
			code: "unreadable",
			reason,
		});
		expect(bytesOf(root).equals(before)).toBe(true);
		expect(developFiles(root)).toEqual(["tasks.json"]);
	};
	const put = (root: string, content: string | Buffer) => {
		mkdirSync(join(root, "develop"), { recursive: true });
		writeFileSync(join(root, "develop", "tasks.json"), content);
	};

	it("malformed JSON, a torn write, and bytes that are not UTF-8", () => {
		for (const content of [
			'{"schemaVersion":"endo.develop-tasks.v0","rev',
			"",
			"not json",
			Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
		]) {
			const root = fresh();
			put(root, content);
			unreadable(root, "malformed");
		}
	});

	it("an unknown version is refused whole, never read as the version it resembles", () => {
		const root = fresh();
		put(root, JSON.stringify({ schemaVersion: "endo.develop-tasks.v2", revision: 0, projects: [], tasks: [] }));
		unreadable(root, "unsupported-version");
	});

	it("a record that breaks the shape is invalid: unknown members, bad ids, orphan tasks, unsafe text, a status out of the list", () => {
		const base = { schemaVersion: "endo.develop-tasks.v0", revision: 1, projects: [], tasks: [] };
		const project = {
			id: `endo.project.${"a".repeat(32)}`,
			name: "n",
			path: "/p",
			observedGitRoot: null,
			createdAtMs: 1,
			updatedAtMs: 1,
			revision: 0,
			selectedTaskId: null,
		};
		const task = {
			id: `endo.task.${"b".repeat(32)}`,
			projectId: project.id,
			title: "t",
			description: "",
			acceptance: "",
			status: "open",
			createdAtMs: 1,
			updatedAtMs: 1,
			revision: 0,
			history: [],
			sessions: [],
		};
		const good = { ...base, projects: [project], tasks: [task] };
		expect(() => validateEndoDevelopTasksFileV0(good)).not.toThrow();
		const cases: unknown[] = [
			{ ...good, extra: 1 },
			{ ...good, tasks: [{ ...task, projectId: `endo.project.${"c".repeat(32)}` }] },
			{ ...good, tasks: [{ ...task, status: "finished" }] },
			{ ...good, tasks: [{ ...task, title: "bad\u202etitle" }] },
			{ ...good, tasks: [{ ...task, description: "esc\u001b[31m" }] },
			{ ...good, tasks: [{ ...task, id: "endo.task.short" }] },
			{ ...good, tasks: [task, task] },
			{ ...good, projects: [{ ...project, selectedTaskId: `endo.task.${"d".repeat(32)}` }] },
			{
				...good,
				tasks: [
					{
						...task,
						sessions: [
							{
								linkId: "0".repeat(16),
								source: "pi-live",
								sessionId: "not-a-session",
								attachment: "a",
								launchId: "1".repeat(16),
								linkedAtMs: 1,
								linkedBy: "operator",
								via: "workbench",
							},
						],
					},
				],
			},
			{ ...good, revision: -1 },
			Object.assign(Object.create(null), good, { projects: [{ ...project, __proto__: null, constructor: 1 }] }),
		];
		for (const [index, value] of cases.entries())
			expect(() => validateEndoDevelopTasksFileV0(value), `case ${index}`).toThrow();
		const root = fresh();
		put(root, JSON.stringify({ ...good, tasks: [{ ...task, status: "finished" }] }));
		unreadable(root, "invalid");
	});

	it("a file over the size limit is not read", () => {
		const root = fresh();
		put(root, Buffer.alloc(ENDO_DEVELOP_TASK_LIMITS_V0.maxFileBytes + 1, 0x20));
		unreadable(root, "too-large");
	});

	it("a symbolic link as the file, and as the directory, is refused and not followed", () => {
		const outside = fresh();
		const secret = join(outside, "elsewhere.json");
		writeFileSync(
			secret,
			JSON.stringify({ schemaVersion: "endo.develop-tasks.v0", revision: 0, projects: [], tasks: [] }),
		);
		const asFile = fresh();
		mkdirSync(join(asFile, "develop"));
		symlinkSync(secret, join(asFile, "develop", "tasks.json"));
		const fileStore = new DevelopTasksStoreV0(asFile);
		expect(fileStore.read()).toEqual({ ok: false, reason: "unsafe-path" });
		expect(fileStore.registerProject({ name: "n", path: "/x", observedGitRoot: null })).toMatchObject({
			ok: false,
			code: "unreadable",
			reason: "unsafe-path",
		});
		const asDirectory = fresh();
		symlinkSync(outside, join(asDirectory, "develop"));
		const dirStore = new DevelopTasksStoreV0(asDirectory);
		expect(dirStore.read()).toEqual({ ok: false, reason: "unsafe-path" });
		expect(dirStore.registerProject({ name: "n", path: "/x", observedGitRoot: null })).toMatchObject({
			ok: false,
			code: "unreadable",
			reason: "unsafe-path",
		});
		// Nothing was written through either link.
		expect(readdirSync(outside).sort()).toEqual(["elsewhere.json"]);
		expect(JSON.parse(readFileSync(secret, "utf8")).revision).toBe(0);
	});
});

describe("text and counts are closed and bounded", () => {
	it("refuses oversized and unsafe text and writes nothing for it", () => {
		const { store, project } = registered(fresh());
		const limits = ENDO_DEVELOP_TASK_LIMITS_V0;
		const refused: Record<string, unknown>[] = [
			{ title: "" },
			{ title: "   " },
			{ title: "x".repeat(limits.maxTitle + 1) },
			{ title: "two\nlines" },
			{ title: "bell\u0007" },
			{ title: "rtl\u202etitle" },
			{ title: "t", description: "y".repeat(limits.maxText + 1) },
			{ title: "t", description: "escape\u001b[2J" },
			{ title: "t", description: "carriage\rreturn" },
			{ title: "t", acceptance: "nul\u0000" },
			{ title: "t", acceptance: "sep\u2028x" },
			{ title: 5 },
			{ title: "t", description: 5 },
		];
		for (const input of refused)
			expect(store.createTask(project.id, input as never), JSON.stringify(input).slice(0, 60)).toMatchObject({
				ok: false,
				code: "bad-request",
			});
		const read = store.read();
		expect(read.ok && read.file.tasks).toEqual([]);
		// The edges are accepted: text at the limit (even all three-byte characters), newlines and tabs.
		expect(store.createTask(project.id, { title: "t", description: "\u2603".repeat(limits.maxText) }).ok).toBe(true);
		expect(
			store.createTask(project.id, {
				title: "x".repeat(limits.maxTitle),
				description: "a\tb\nc".padEnd(limits.maxText, "z"),
			}).ok,
		).toBe(true);
	});

	it("stops at the task and project limits", () => {
		const { store, project } = registered(fresh());
		for (let i = 0; i < ENDO_DEVELOP_TASK_LIMITS_V0.maxTasks; i += 1)
			ok(store.createTask(project.id, { title: `t${i}` }));
		expect(store.createTask(project.id, { title: "one more" })).toMatchObject({ ok: false, code: "limit" });
		const root = fresh();
		const small = new DevelopTasksStoreV0(root);
		for (let i = 0; i < ENDO_DEVELOP_TASK_LIMITS_V0.maxProjects; i += 1)
			ok(small.registerProject({ name: `p${i}`, path: `/p/${i}`, observedGitRoot: null }));
		expect(small.registerProject({ name: "p", path: "/p/x", observedGitRoot: null })).toMatchObject({
			ok: false,
			code: "limit",
		});
	});

	it("the worst-case task fits the workbench request body, even with every character escaped", () => {
		const limits = ENDO_DEVELOP_TASK_LIMITS_V0;
		// Newlines are the costliest ASCII (2 bytes escaped); the byte cap bounds the multibyte case.
		const body = JSON.stringify({
			title: "☃".repeat(limits.maxTitle),
			description: "\n".repeat(limits.maxText),
			acceptance: "\n".repeat(limits.maxText),
		});
		expect(Buffer.byteLength(body)).toBeLessThan(40 * 1024);
		const multibyte = JSON.stringify({
			title: "t",
			description: "☃".repeat(limits.maxText),
			acceptance: "☃".repeat(limits.maxText),
		});
		expect(Buffer.byteLength(multibyte)).toBeLessThan(40 * 1024);
	});
});

describe("selection is remembered and changes nothing else", () => {
	it("keeps the chosen task across a restart without touching its status or revision", () => {
		const root = fresh();
		const { store, project } = registered(root);
		const a = ok(store.createTask(project.id, { title: "a" }));
		const b = ok(store.createTask(project.id, { title: "b" }, { select: true }));
		ok(store.selectTask(project.id, a.id));
		const read = new DevelopTasksStoreV0(root).read();
		expect(read.ok && read.file.projects[0]?.selectedTaskId).toBe(a.id);
		expect(read.ok && read.file.tasks.map((t) => [t.status, t.revision])).toEqual([
			["open", 0],
			["open", 0],
		]);
		expect(b.status).toBe("open");
		ok(store.selectTask(project.id, null));
		// Choosing what is already chosen writes nothing at all.
		const bytes = bytesOf(root);
		ok(store.selectTask(project.id, null));
		expect(bytesOf(root).equals(bytes)).toBe(true);
		expect(store.selectTask(project.id, "endo.task.nothing")).toMatchObject({ ok: false, code: "bad-request" });
		expect(store.selectTask(project.id, `endo.task.${"e".repeat(32)}`)).toMatchObject({
			ok: false,
			code: "not-found",
		});
	});
});
