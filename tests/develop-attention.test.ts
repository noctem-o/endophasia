// The attention overview below the browser (docs/designs/develop-attention.md): the read-only projection over the real stores, its route,
// the page's wire gate, and the pure classification. What must hold: "latest" is per command and never lets an older pass hide a newer
// failure; a stale or uncompared check is never shown as current; a finished task is never urgent; what could not be read is said; the
// order is total and stable; the read is bounded; and nothing is written.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchTasksV0 } from "../adapters/pi/workbench-tasks.ts";
import {
	ENDO_DEVELOP_ATTENTION_LIMITS_V0,
	type EndoDevelopAttentionCheckV0,
	type EndoDevelopAttentionTaskV0,
	type EndoDevelopAttentionViewV0,
} from "../protocol/develop-attention.ts";
import type { EndoReceiptCurrentV0, EndoReceiptFactsV0 } from "../protocol/develop-receipts.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { endoDevelopAttentionViewV0 } from "../runtime/contracts/develop-attention.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { LaunchReader, type LaunchReply } from "../studio-ui/src/model/attempts-reader.ts";
import { evidenceOf, type Item, lineText, type Overview, overviewOf } from "../studio-ui/src/model/attention.ts";
import { ATTENTION_LIMITS, readAttention } from "../studio-ui/src/model/attention-wire.ts";
import type { Task } from "../studio-ui/src/model/workspace-wire.ts";
import { removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { receiptAt, seedAttention, taskIn } from "./studio-attention-fixtures.ts";

afterEach(() => removeTempRoots((r) => rmSync(r, { recursive: true, force: true })));

const HEAD = "a".repeat(40);
const CURRENT: EndoReceiptCurrentV0 = {
	worktree: "/work/parser",
	commonDir: "/work/parser/.git",
	commit: HEAD,
	clean: true,
};
const LAUNCH = "0123456789abcdef";
const T0 = Date.UTC(2026, 10, 3, 13, 0);
const at = (minutes: number) => T0 + minutes * 60_000;

function project(root = tempRoot("endo-attention-")) {
	const tasks = new DevelopTasksStoreV0(root);
	const made = tasks.registerProject({ name: "Parser work", path: "/work/parser", observedGitRoot: "/work/parser" });
	if (!made.ok) throw new Error(made.code);
	const attempts = new DevelopAttemptsStoreV0(root);
	const receipts = new DevelopReceiptsStoreV0(root);
	// A clock that moves: attempts prepared one after another are told apart by time, as they would be by hand.
	let clock = T0;
	const service = new DevelopAttemptsServiceV0(tasks, attempts, {
		now: () => {
			clock += 1000;
			return clock;
		},
	});
	const projectId = made.value.id;
	const attempt = (taskId: string, objective = "Do the work.") => {
		const got = service.prepare(projectId, taskId, { objective });
		if (!got.ok) throw new Error(got.code);
		return got.value.id;
	};
	const check = (attemptId: string, minutes: number, change: Partial<EndoReceiptFactsV0> = {}) => {
		const written = receipts.write(receiptAt(CURRENT, attemptId, projectId, at(minutes), change));
		if (written !== "created") throw new Error(written);
	};
	const view = (
		current: EndoReceiptCurrentV0 | null = CURRENT,
		limits?: { maxReceiptFiles: number; maxReceiptBytes: number },
	) => endoDevelopAttentionViewV0({ tasks, attempts, receipts }, { projectId, launchId: LAUNCH }, current, limits);
	const workspaceTasks = (): Task[] => {
		const scope = new DevelopWorkspaceServiceV0(tasks).forLaunch(
			{ projectId, launchDirectory: "/nonexistent" },
			{ launchId: LAUNCH, attachment: "pi.default", session: null },
		);
		return scope.view().tasks as Task[];
	};
	return { root, tasks, attempts, receipts, projectId, attempt, check, view, workspaceTasks, service };
}

const failing = { execution: { kind: "exited", code: 1 } } as const;
const lint = {
	argv: ["npm", "run", "lint"],
	executable: "/usr/bin/npm",
	realExecutable: "/usr/lib/npm/bin/npm-cli.js",
	timeoutMs: 600_000,
};
const elsewhere = (commit: string) => ({
	revision: { commit, tree: "e".repeat(40), branch: "refs/heads/main" },
	after: {
		state: "observed" as const,
		sameRepository: true,
		commit,
		tree: "e".repeat(40),
		clean: true,
		reflogsUnchanged: true,
		rulesUnchanged: true,
	},
});

/** Every file under a directory with its size and modification time: to show a read changed nothing. */
function snapshot(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			const s = statSync(p);
			if (s.isDirectory()) walk(p);
			else out.push(`${p}:${s.size}:${s.mtimeMs}:${readFileSync(p, "utf8").length}`);
		}
	};
	walk(dir);
	return out;
}

const sectionOf = (o: Overview, taskId: string) =>
	(["attention", "waiting", "open", "done"] as const).find((s) => o[s].some((i) => i.task.id === taskId));
const itemOf = (o: Overview, taskId: string): Item =>
	[...o.attention, ...o.waiting, ...o.open, ...o.done].find((i) => i.task.id === taskId) as Item;
const textsOf = (item: Item) => item.lines.map(lineText);

describe("the projection: the latest check of each command, per task", () => {
	it("an earlier failure followed by a later pass is the pass; a later failure after a pass is the failure", () => {
		const p = project();
		const resolved = taskIn(p.root, p.projectId, "Resolved", "in-progress");
		const regressed = taskIn(p.root, p.projectId, "Regressed", "in-progress");
		const a = p.attempt(resolved);
		p.check(a, 1, failing);
		p.check(a, 2);
		const b = p.attempt(regressed);
		p.check(b, 1);
		p.check(b, 2, failing);
		const view = p.view();
		const of = (id: string) => view.tasks.find((t) => t.taskId === id) as EndoDevelopAttentionTaskV0;
		expect(of(resolved).checks.map((c) => [c.command, c.outcome, c.others])).toEqual([
			["npm test", "passed", { passed: 0, failed: 1, inconclusive: 0 }],
		]);
		expect(of(regressed).checks.map((c) => [c.command, c.outcome, c.others])).toEqual([
			["npm test", "failed", { passed: 1, failed: 0, inconclusive: 0 }],
		]);
	});

	it("a later pass of ANOTHER command never hides a failure; the latest is chosen across attempts by start time", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Two commands", "in-progress");
		const first = p.attempt(task, "First try.");
		p.check(first, 1, failing);
		const second = p.attempt(task, "Second try.");
		p.check(second, 5, { check: lint });
		const view = p.view();
		const checks = view.tasks[0]?.checks ?? [];
		// The failure is listed first (what did not pass first), and comes from the older attempt: a check is about the code, not the attempt.
		expect(checks.map((c) => [c.command, c.outcome, c.attemptId])).toEqual([
			["npm test", "failed", first],
			["npm run lint", "passed", second],
		]);
		expect(view.tasks[0]?.latestAttempt?.id).toBe(second);
		expect(view.tasks[0]?.attempts).toBe(2);
	});

	it("a later pass in another worktree or repository, or at an older commit, never hides a failure at this HEAD", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Bisected", "in-progress");
		const a = p.attempt(task);
		p.check(a, 1, failing);
		// Later: the same command passes in a linked worktree, in another clone, and at an older commit here.
		p.check(a, 2, { repository: { worktree: "/work/linked", commonDir: CURRENT.commonDir, linked: true } });
		p.check(a, 3, { repository: { worktree: "/clone", commonDir: "/clone/.git", linked: false } });
		p.check(a, 4, elsewhere("f".repeat(40)));
		const checks = p.view().tasks[0]?.checks ?? [];
		expect(checks.map((c) => [c.outcome, c.relation])).toEqual([
			["failed", "at-head"],
			["passed", "other-repository"],
			["passed", "other-worktree"],
		]);
		// The pass at the older commit is counted beside the failure, never put in its place.
		expect(checks[0]?.others).toEqual({ passed: 1, failed: 0, inconclusive: 0 });
		// Once HEAD has moved on, the newest run of the check is the latest again.
		const moved = p.view({ ...CURRENT, commit: "b".repeat(40) }).tasks[0]?.checks ?? [];
		expect(moved[0]).toMatchObject({ outcome: "passed", relation: "head-differs", commit: "f".repeat(40) });
	});

	it("relates each latest check to the HEAD observed once for the read, and says when HEAD was not observed", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Relations", "review");
		const a = p.attempt(task);
		p.check(a, 1, elsewhere("f".repeat(40)));
		p.check(a, 2, {
			check: lint,
			repository: { worktree: "/work/other", commonDir: CURRENT.commonDir, linked: true },
		});
		const relations = (v: EndoDevelopAttentionViewV0) =>
			Object.fromEntries((v.tasks[0]?.checks ?? []).map((c) => [c.command, c.relation]));
		expect(relations(p.view())).toEqual({ "npm test": "head-differs", "npm run lint": "other-worktree" });
		expect(p.view().head).toEqual({ commit: HEAD, clean: true });
		const unobserved = p.view(null);
		expect(unobserved.head).toBeNull();
		expect(relations(unobserved)).toEqual({ "npm test": "unavailable", "npm run lint": "unavailable" });
		expect(relations(p.view({ ...CURRENT, clean: false, commit: "f".repeat(40) }))["npm test"]).toBe(
			"at-head-changed",
		);
		expect(relations(p.view({ ...CURRENT, commonDir: "/elsewhere/.git" }))["npm test"]).toBe("other-repository");
	});

	it("does not read a done task's receipts, and lists every task that is not done (with or without attempts) in file order", () => {
		const p = project();
		const done = taskIn(p.root, p.projectId, "Finished", "done");
		const open = taskIn(p.root, p.projectId, "Not started", "open");
		p.check(p.attempt(done), 1, failing);
		const reads: string[] = [];
		const receipts = {
			readAtMost: (id: string, max: { files: number; bytes: number }) => {
				reads.push(id);
				return p.receipts.readAtMost(id, max);
			},
		} as unknown as DevelopReceiptsStoreV0;
		const view = endoDevelopAttentionViewV0(
			{ tasks: p.tasks, attempts: p.attempts, receipts },
			{ projectId: p.projectId, launchId: LAUNCH },
			CURRENT,
		);
		expect(reads).toEqual([]);
		expect(view.tasks.map((t) => t.taskId)).toEqual([open]);
		expect(view.tasks[0]).toMatchObject({ attempts: 0, latestAttempt: null, checks: [], unreadable: 0 });
	});

	it("counts what could not be read: a receipt directory that is a link, and files that are not receipts", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Gaps", "in-progress");
		const linked = p.attempt(task, "Linked.");
		const junk = p.attempt(task, "Junk.");
		p.check(junk, 1);
		const target = join(p.root, "elsewhere");
		mkdirSync(target);
		symlinkSync(target, join(p.receipts.directory, linked));
		writeFileSync(join(p.receipts.directory, junk, "notes.txt"), "not a receipt");
		const t = p.view().tasks[0] as EndoDevelopAttentionTaskV0;
		expect([t.unreadable, t.problems, t.skipped, t.checks.length]).toEqual([1, 1, 0, 1]);
	});

	it("is bounded: a read stops at its limit (review first, newest attempt first) and says which attempts it skipped", () => {
		const p = project();
		const open = taskIn(p.root, p.projectId, "Open, read last", "open");
		const review = taskIn(p.root, p.projectId, "Review, read first", "review");
		const o = p.attempt(open);
		for (let i = 0; i < 3; i += 1) p.check(o, i);
		const r = p.attempt(review);
		for (let i = 0; i < 3; i += 1) p.check(r, i);
		const view = p.view(CURRENT, { maxReceiptFiles: 4, maxReceiptBytes: 1 << 30 });
		expect(view.truncated).toBe(true);
		const of = (id: string) => view.tasks.find((t) => t.taskId === id) as EndoDevelopAttentionTaskV0;
		expect([of(review).checks.length, of(review).skipped]).toEqual([1, 0]);
		expect([of(open).checks.length, of(open).skipped]).toEqual([0, 1]);
		// File order in the answer, whatever order they were read in.
		expect(view.tasks.map((t) => t.taskId)).toEqual([open, review]);
		// The byte budget bounds it the same way: a directory whose files add up to more than is left is not read at all.
		const bytes = p.view(CURRENT, { maxReceiptFiles: 1000, maxReceiptBytes: 1024 });
		expect(bytes.truncated).toBe(true);
		expect(bytes.tasks.every((t) => t.checks.length === 0 && t.skipped === 1)).toBe(true);
		// And the default limits hold for the whole project, not per task.
		expect(ENDO_DEVELOP_ATTENTION_LIMITS_V0).toMatchObject({
			maxReceiptFiles: 1000,
			maxReceiptBytes: 8 * 1024 * 1024,
		});
	});

	it("lists at most five commands per task, the ones that did not pass first, and counts the rest; a command is shown cut and safe", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Many commands", "in-progress");
		const a = p.attempt(task);
		for (let i = 0; i < 7; i += 1)
			p.check(a, i, {
				check: { ...lint, argv: ["npm", "run", `job-${i}`, ...(i === 0 ? ["\u202e", "x".repeat(300)] : [])] },
				...(i < 2 ? failing : {}),
			});
		const t = p.view().tasks[0] as EndoDevelopAttentionTaskV0;
		expect(t.checks).toHaveLength(ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxChecksPerTask);
		expect(t.checks.slice(0, 2).map((c) => c.outcome)).toEqual(["failed", "failed"]);
		expect(t.more).toEqual({ commands: 2, notPassing: 0 });
		const cut = t.checks.find((c) => c.command.startsWith("npm run job-0")) as EndoDevelopAttentionCheckV0;
		expect(cut.command.length).toBe(ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxCommandChars);
		expect(cut.command).not.toContain("\u202e");
		expect(cut.command.endsWith("…")).toBe(true);
	});

	it("says when the task file or the attempt records cannot be read, or the project is not in the file, and claims nothing", () => {
		const p = project();
		taskIn(p.root, p.projectId, "Anything", "in-progress");
		const other = endoDevelopAttentionViewV0(
			{ tasks: p.tasks, attempts: p.attempts, receipts: p.receipts },
			{ projectId: `endo.project.${"0".repeat(32)}`, launchId: LAUNCH },
			CURRENT,
		);
		expect([other.state, other.tasks]).toEqual(["unknown-project", []]);
		const tasksFile = join(p.root, "develop", "tasks.json");
		writeFileSync(tasksFile, "{ torn");
		expect(p.view()).toMatchObject({ state: "unreadable", tasks: [], truncated: false });
	});

	it("writes nothing: the store is byte-for-byte and stamp-for-stamp the same after many reads", () => {
		const p = project();
		const current = { ...CURRENT };
		seedAttention(p.root, p.projectId, current);
		const before = snapshot(join(p.root, "develop"));
		for (let i = 0; i < 5; i += 1) p.view();
		expect(snapshot(join(p.root, "develop"))).toEqual(before);
	});
});

describe("the route: GET workspace/attention, read-only, nothing chosen by the request", () => {
	const scope = (withAttempts: boolean) => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Routed", "review");
		p.check(p.attempt(task), 1, failing);
		const launch = new DevelopWorkspaceServiceV0(
			p.tasks,
			withAttempts ? { attempts: p.attempts, receipts: { store: p.receipts, current: async () => CURRENT } } : {},
		).forLaunch(
			{ projectId: p.projectId, launchDirectory: "/work/parser" },
			{ launchId: LAUNCH, attachment: "pi.default", session: null },
		);
		return { p, routes: new WorkbenchTasksV0(launch) };
	};

	it("serves the projection on a bare GET; refuses a query, a further path and any POST; and changes nothing", async () => {
		const { p, routes } = scope(true);
		const before = snapshot(join(p.root, "develop"));
		const ok = await routes.route(["workspace", "attention"], "GET", "", null);
		expect(ok.status).toBe(200);
		expect(readAttention(ok.body)).not.toBeNull();
		expect((ok.body as EndoDevelopAttentionViewV0).tasks[0]?.checks[0]?.outcome).toBe("failed");
		expect((await routes.route(["workspace", "attention"], "GET", "projectId=x", null)).status).toBe(400);
		expect((await routes.route(["workspace", "attention", "x"], "GET", "", null)).status).toBe(404);
		expect((await routes.route(["workspace", "attention"], "POST", "", {})).status).toBe(404);
		// The synchronous handler alone does not serve it.
		expect(routes.handle(["workspace", "attention"], "GET", "", null).status).toBe(404);
		expect(snapshot(join(p.root, "develop"))).toEqual(before);
		// No path, no argv beyond the shown command, no store location in the answer.
		expect(JSON.stringify(ok.body)).not.toMatch(/\/work\/parser|tasks\.json|executable|realExecutable/);
	});

	it("is absent (404) for a launch given no attempt records", async () => {
		const { routes } = scope(false);
		expect((await routes.route(["workspace", "attention"], "GET", "", null)).status).toBe(404);
	});
});

describe("the page's wire gate", () => {
	const real = () => {
		const p = project();
		seedAttention(p.root, p.projectId, CURRENT);
		return JSON.parse(JSON.stringify(p.view())) as EndoDevelopAttentionViewV0;
	};

	it("accepts what the broker serves, and mirrors the protocol's limits", () => {
		expect(readAttention(real())).not.toBeNull();
		expect(ATTENTION_LIMITS).toEqual({
			maxChecksPerTask: ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxChecksPerTask,
			maxCommandChars: ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxCommandChars,
		});
	});

	it("refuses a body that claims more than its facts: a pass with a failing exit, a current relation without a HEAD, and more", () => {
		const mutate = (change: (v: EndoDevelopAttentionViewV0) => void) => {
			const v = real();
			change(v);
			return readAttention(v);
		};
		const first = (v: EndoDevelopAttentionViewV0) =>
			v.tasks.find((t) => t.checks.length > 0)?.checks[0] as EndoDevelopAttentionCheckV0;
		expect(
			mutate((v) => {
				const c = first(v);
				c.outcome = "passed";
				c.execution = { kind: "exited", code: 1 };
				c.reasons = [];
			}),
		).toBeNull();
		expect(
			mutate((v) => {
				v.head = null;
			}),
		).toBeNull();
		expect(
			mutate((v) => {
				first(v).relation = "at-head";
				(v.head as { clean: boolean }).clean = false;
			}),
		).toBeNull();
		expect(
			mutate((v) => {
				first(v).relation = "head-differs";
				first(v).commit = v.head?.commit ?? "";
			}),
		).toBeNull();
		expect(
			mutate((v) => {
				(v as unknown as Record<string, unknown>).path = "/work";
			}),
		).toBeNull();
		expect(
			mutate((v) => {
				(v.tasks[0] as EndoDevelopAttentionTaskV0).skipped = 1;
			}),
		).toBeNull();
		expect(
			mutate((v) => {
				v.tasks.push({ ...(v.tasks[0] as EndoDevelopAttentionTaskV0) });
			}),
		).toBeNull();
		expect(
			mutate((v) => {
				v.state = "unreadable";
			}),
		).toBeNull();
		expect(
			mutate((v) => {
				first(v).command = "npm\u202etest";
			}),
		).toBeNull();
	});
});

// ---- the classification ------------------------------------------------------------------------------------------------------------

/** A projection the page might hold, for tasks read from a real store, with checks given by hand. */
function evidence(
	tasks: Task[],
	checks: Record<string, Partial<EndoDevelopAttentionCheckV0>[]>,
	options: {
		head?: EndoDevelopAttentionViewV0["head"];
		extra?: Record<string, Partial<EndoDevelopAttentionTaskV0>>;
	} = {},
): EndoDevelopAttentionViewV0 {
	let n = 0;
	const check = (c: Partial<EndoDevelopAttentionCheckV0>): EndoDevelopAttentionCheckV0 => {
		n += 1;
		return {
			command: "npm test",
			attemptId: `endo.attempt.${"1".repeat(32)}`,
			receiptId: `endo.receipt.${n.toString(16).padStart(32, "0")}`,
			commit: HEAD,
			startedAtMs: at(n),
			endedAtMs: at(n) + 1000,
			outcome: "passed",
			execution: { kind: "exited", code: 0 },
			reasons: [],
			relation: "at-head",
			others: { passed: 0, failed: 0, inconclusive: 0 },
			...c,
		};
	};
	return {
		schemaVersion: "endo.develop-attention-view.v0",
		launchId: LAUNCH,
		state: "ready",
		taskRevision: 7,
		head: options.head === undefined ? { commit: HEAD, clean: true } : options.head,
		truncated: false,
		tasks: tasks
			.filter((t) => t.status !== "done")
			.map((t) => ({
				taskId: t.id,
				attempts: (checks[t.id]?.length ?? 0) > 0 ? 1 : 0,
				latestAttempt:
					(checks[t.id]?.length ?? 0) > 0
						? { id: `endo.attempt.${"1".repeat(32)}`, state: "handed-off", preparedAtMs: at(0) }
						: null,
				unreadable: 0,
				skipped: 0,
				problems: 0,
				checks: (checks[t.id] ?? []).map(check),
				more: { commands: 0, notPassing: 0 },
				...options.extra?.[t.id],
			})),
	};
}

describe("the classification: what needs the operator, and why", () => {
	const fixture = () => {
		const p = project();
		const ids = {
			review: taskIn(p.root, p.projectId, "Review, nothing checked", "review", "please look"),
			reviewStale: taskIn(p.root, p.projectId, "Review, stale pass", "review"),
			failed: taskIn(p.root, p.projectId, "Failed", "in-progress"),
			resolved: taskIn(p.root, p.projectId, "Failed then passed", "in-progress"),
			inconclusive: taskIn(p.root, p.projectId, "Timed out", "open"),
			stalePass: taskIn(p.root, p.projectId, "In progress, stale pass", "in-progress"),
			blocked: taskIn(p.root, p.projectId, "Blocked", "blocked", "waiting on the vendor"),
			done: taskIn(p.root, p.projectId, "Done, old failure", "done"),
			open: taskIn(p.root, p.projectId, "Open", "open"),
		};
		return { p, ids, tasks: p.workspaceTasks() };
	};

	it("puts each task in one section, for reasons that follow from its status and its latest checks alone", () => {
		const { ids, tasks } = fixture();
		const view = evidence(tasks, {
			[ids.reviewStale]: [{ relation: "head-differs", commit: "f".repeat(40) }],
			[ids.failed]: [{ outcome: "failed", execution: { kind: "exited", code: 1 } }],
			[ids.resolved]: [{ others: { passed: 0, failed: 1, inconclusive: 0 } }],
			[ids.inconclusive]: [{ outcome: "inconclusive", execution: { kind: "timed-out" }, reasons: ["timed-out"] }],
			[ids.stalePass]: [{ relation: "head-differs", commit: "f".repeat(40) }],
			[ids.done]: [{ outcome: "failed", execution: { kind: "exited", code: 2 } }],
		});
		const o = overviewOf(tasks, "shown", view, 7);
		expect(Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sectionOf(o, id)]))).toEqual({
			review: "attention",
			reviewStale: "attention",
			failed: "attention",
			resolved: "waiting",
			inconclusive: "attention",
			stalePass: "waiting",
			blocked: "waiting",
			done: "done",
			open: "open",
		});
		// The order: decisions, then failures, then inconclusive; the blocked task before the one in progress.
		expect(o.attention.map((i) => i.flags[0])).toEqual(["decision", "decision", "failed", "inconclusive"]);
		expect(o.waiting[0]?.task.id).toBe(ids.blocked);
		expect(itemOf(o, ids.reviewStale).flags).toEqual(["decision", "reconsider"]);

		expect(textsOf(itemOf(o, ids.review))).toEqual([
			"Marked ready for review; the decision is yours.",
			"Your note: “please look”",
			"No attempts or observed checks recorded.",
		]);
		expect(textsOf(itemOf(o, ids.reviewStale))).toContain(
			`Passing \`npm test\` belongs to an earlier commit (fffffff); HEAD is now ${HEAD.slice(0, 7)}.`,
		);
		expect(textsOf(itemOf(o, ids.failed))[0]).toBe(
			"Latest observed `npm test` exited with code 1 at the current HEAD.",
		);
		expect(textsOf(itemOf(o, ids.inconclusive))[0]).toBe(
			"Latest observed `npm test` was stopped at its time limit at the current HEAD.",
		);
		expect(textsOf(itemOf(o, ids.resolved))).toContain(
			"Latest observed `npm test` passed at the current HEAD. Other runs of it here: 1 failed.",
		);
		expect(textsOf(itemOf(o, ids.stalePass))).toContain(
			"Latest observed `npm test` passed at an earlier commit (fffffff).",
		);
		expect(textsOf(itemOf(o, ids.blocked))).toEqual(["Marked blocked by you.", "Your note: “waiting on the vendor”"]);
		// A finished task is never urgent, and its old checks are not read or shown.
		expect(itemOf(o, ids.done).lines).toEqual([]);
		// The row opens the check it is about.
		expect(itemOf(o, ids.failed).focus?.receiptId).toBe(
			view.tasks.find((t) => t.taskId === ids.failed)?.checks[0]?.receiptId,
		);
		expect(itemOf(o, ids.review).focus).toBeNull();
	});

	it("never calls anything verified, accepted, approved or in progress by an agent; a missing check is only missing", () => {
		const { ids, tasks } = fixture();
		const o = overviewOf(tasks, "shown", evidence(tasks, { [ids.review]: [] }), 7);
		const all = [...o.attention, ...o.waiting, ...o.open, ...o.done].flatMap(textsOf).join("\n");
		expect(all).not.toMatch(/verified(?! )|accepted|approved|agent is|working on|fail(ed|ing) task|priority|score/i);
		expect(all).not.toMatch(/task (has )?failed/i);
	});

	it("says how each check relates to HEAD in its own words, and never collapses them into one 'stale'", () => {
		const { ids, tasks } = fixture();
		const relations = ["at-head-changed", "head-differs", "other-worktree", "other-repository"] as const;
		const words = relations.map((relation) => {
			const view = evidence(tasks, {
				[ids.failed]: [
					{
						outcome: "failed",
						execution: { kind: "exited", code: 1 },
						relation,
						commit: relation === "head-differs" ? "f".repeat(40) : HEAD,
					},
				],
				[ids.reviewStale]: [{ relation, commit: relation === "head-differs" ? "f".repeat(40) : HEAD }],
			});
			const o = overviewOf(tasks, "shown", view, 7);
			return [textsOf(itemOf(o, ids.failed))[0], textsOf(itemOf(o, ids.reviewStale))[1]];
		});
		expect(words).toEqual([
			[
				"Latest observed `npm test` exited with code 1 at the current HEAD; the working tree has changed since.",
				"Passing `npm test` was recorded at the current HEAD, but the working tree has changed since.",
			],
			[
				"Latest observed `npm test` exited with code 1 at an earlier commit (fffffff).",
				`Passing \`npm test\` belongs to an earlier commit (fffffff); HEAD is now ${HEAD.slice(0, 7)}.`,
			],
			[
				"Latest observed `npm test` exited with code 1 in a different working tree; not compared with this one.",
				"Passing `npm test` was recorded in a different working tree; not compared with this one.",
			],
			[
				"Latest observed `npm test` exited with code 1 in a different repository; not compared.",
				"Passing `npm test` was recorded in a different repository; not compared.",
			],
		]);
		// HEAD not observed: every check is "cannot currently be compared", and the overview says why once.
		const blind = evidence(
			tasks,
			{
				[ids.failed]: [{ outcome: "failed", execution: { kind: "exited", code: 1 }, relation: "unavailable" }],
				[ids.reviewStale]: [{ relation: "unavailable" }],
			},
			{ head: null },
		);
		const o = overviewOf(tasks, "shown", blind, 7);
		expect(textsOf(itemOf(o, ids.failed))[0]).toBe(
			"Latest observed `npm test` exited with code 1; it cannot currently be compared with this worktree.",
		);
		expect(textsOf(itemOf(o, ids.reviewStale))[1]).toBe(
			"Passing `npm test` cannot currently be compared with this worktree.",
		);
		expect(o.notes).toContain("This worktree's HEAD could not be read, so no check is compared with it.");
	});

	it("says what could not be read, per task and for the read, and never takes it for 'nothing to see'", () => {
		const { ids, tasks } = fixture();
		const view = evidence(
			tasks,
			{},
			{
				extra: {
					[ids.failed]: {
						attempts: 3,
						latestAttempt: { id: `endo.attempt.${"2".repeat(32)}`, state: "reported", preparedAtMs: at(0) },
						unreadable: 1,
						problems: 2,
						skipped: 1,
					},
				},
			},
		);
		view.truncated = true;
		const o = overviewOf(tasks, "shown", view, 8);
		expect(textsOf(itemOf(o, ids.failed))).toEqual([
			"Latest attempt: Result reported, not verified.",
			"One attempt's checks could not be read; what is shown may be incomplete.",
			"2 files among its checks could not be used.",
			"One attempt's checks were not read: the overview's read limit was reached.",
		]);
		expect(o.gaps).toBe(true);
		// A review task whose checks were not all read never says it has none.
		const review = evidence(
			tasks,
			{},
			{
				extra: {
					[ids.review]: {
						attempts: 1,
						latestAttempt: { id: `endo.attempt.${"3".repeat(32)}`, state: "prepared", preparedAtMs: at(0) },
						unreadable: 1,
					},
				},
			},
		);
		expect(textsOf(itemOf(overviewOf(tasks, "shown", review, 7), ids.review))).toContain(
			"No observed checks were read.",
		);
		expect(overviewOf(tasks, "shown", evidence(tasks, {}), 7).gaps).toBe(false);
		expect(o.notes).toEqual([
			"Not every check was read: the overview's read limit was reached. The tasks affected say so.",
			"The tasks changed after the checks were read. Refresh to read them together.",
		]);
		// A task the projection does not list (made or reopened after it was read): said, not taken as "no checks".
		const partial = { ...view, truncated: false, tasks: view.tasks.filter((t) => t.taskId !== ids.open) };
		expect(textsOf(itemOf(overviewOf(tasks, "shown", partial, 7), ids.open))).toEqual([
			"Its checks were not read: it changed after the overview was last read. Refresh to read them.",
		]);
		// No projection at all: the statuses still sort the tasks, and the overview says no checks are shown.
		for (const state of ["absent", "pending", "failed"] as const) {
			const none = overviewOf(tasks, state, null, 7);
			expect(none.evidence).toBe(state);
			expect(none.attention.map((i) => i.task.id).sort()).toEqual([ids.review, ids.reviewStale].sort());
			expect(none.attention.every((i) => i.flags.join() === "decision")).toBe(true);
		}
		const unreadable = overviewOf(tasks, "shown", { ...view, state: "unreadable", tasks: [], truncated: false }, 7);
		expect(unreadable.evidence).toBe("unreadable");
	});

	it("is deterministic: any order of the same tasks gives the same sections in the same order, ties broken by id", () => {
		const { ids, tasks } = fixture();
		const view = evidence(tasks, {
			[ids.failed]: [{ outcome: "failed", execution: { kind: "exited", code: 1 } }],
			[ids.inconclusive]: [
				{ outcome: "inconclusive", execution: { kind: "interrupted" }, reasons: ["interrupted"] },
			],
		});
		const shape = (o: Overview) =>
			(["attention", "waiting", "open", "done"] as const).map((s) => o[s].map((i) => i.task.id));
		const expected = shape(overviewOf(tasks, "shown", view, 7));
		let seed = 7;
		for (let round = 0; round < 20; round += 1) {
			const shuffled = [...tasks].sort(() => {
				seed = (seed * 48271) % 2147483647;
				return (seed % 3) - 1;
			});
			expect(shape(overviewOf(shuffled, "shown", { ...view, tasks: [...view.tasks].reverse() }, 7))).toEqual(
				expected,
			);
		}
	});

	it("stays bounded and readable with several dozen tasks", () => {
		const p = project();
		for (let i = 0; i < 48; i += 1)
			taskIn(
				p.root,
				p.projectId,
				`Task ${i}`,
				(["open", "in-progress", "review", "blocked", "done"] as const)[i % 5],
			);
		const tasks = p.workspaceTasks();
		const o = overviewOf(tasks, "shown", evidence(tasks, {}), 7);
		expect(o.attention.length + o.waiting.length + o.open.length + o.done.length).toBe(48);
		expect(new Set([...o.attention, ...o.waiting, ...o.open, ...o.done].map((i) => i.task.id)).size).toBe(48);
		expect(Math.max(...[...o.attention, ...o.waiting, ...o.open].map((i) => i.lines.length))).toBeLessThanOrEqual(12);
	});
});

describe("the reader the overview shares with the attempts", () => {
	const deferred = () => {
		let resolve!: (r: LaunchReply<{ n: number }>) => void;
		const promise = new Promise<LaunchReply<{ n: number }>>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	};

	it("drops an answer from a launch or a pairing that has gone, and is current only for a read made under the present ones", async () => {
		const pending: ReturnType<typeof deferred>[] = [];
		const reader = new LaunchReader<{ n: number }>(
			() => {
				const d = deferred();
				pending.push(d);
				return d.promise;
			},
			() => {},
		);
		reader.sync({ grant: "g1", launchId: "L1", active: true, ready: true, trigger: 1 });
		expect(pending).toHaveLength(1);
		// The launch changes while the read is in flight: the old answer, when it comes, changes nothing.
		reader.sync({ grant: "g1", launchId: "L2", active: true, ready: true, trigger: 2 });
		pending[0]?.resolve({ kind: "attention", record: { n: 1 } });
		await Promise.resolve();
		expect(reader.state.view).toBeNull();
		pending[1]?.resolve({ kind: "attention", record: { n: 2 } });
		await new Promise((r) => setTimeout(r, 0));
		expect(reader.state).toEqual({ view: { n: 2 }, current: true, busy: false, problem: null });
		// The pairing is revoked while a read is in flight: what was read stays, marked not current, and the late answer is dropped.
		reader.sync({ grant: "g1", launchId: "L2", active: true, ready: true, trigger: 3 });
		reader.sync({ grant: null, launchId: "L2", active: true, ready: true, trigger: 3 });
		pending[2]?.resolve({ kind: "attention", record: { n: 3 } });
		await new Promise((r) => setTimeout(r, 0));
		expect(reader.state).toEqual({ view: { n: 2 }, current: false, busy: false, problem: "unpaired" });
	});
});

describe("at the broker: behind the grant, and a revocation during the read wins", () => {
	it("answers a held read with the refusal when the pairing went while it waited for HEAD", async () => {
		const { WorkbenchBrokerV0 } = await import("../adapters/pi/workbench.ts");
		const { FakeDesk, FakeSession, Approval } = await import("./workbench-fixtures.ts");
		const { OTHER_KEY } = await import("./cockpit-keyed.ts");
		const p = project();
		taskIn(p.root, p.projectId, "Held", "review");
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let held = false;
		const session = new FakeSession();
		const approval = new Approval();
		const broker = new WorkbenchBrokerV0({
			session,
			key: OTHER_KEY,
			attachment: "pi.default",
			approver: approval.approver,
			interventions: new FakeDesk(session),
			tasks: {
				open: (host) =>
					new DevelopWorkspaceServiceV0(p.tasks, {
						attempts: p.attempts,
						receipts: {
							store: p.receipts,
							current: async () => {
								if (held) await gate;
								return CURRENT;
							},
						},
					}).forLaunch({ projectId: p.projectId, launchDirectory: "/work/parser" }, host),
			},
		});
		const call = (route: string, grant: string | null) =>
			broker.handle({ method: "GET", route: route.split("/"), query: "", grant, body: null });
		expect((await call("workspace/attention", null)).status).toBe(401);
		const { code } = broker.issuePairingCode();
		const grant = (
			(await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code } })).body as {
				grant: string;
			}
		).grant;
		expect((await call("workspace/attention", grant)).status).toBe(200);
		held = true;
		for (const route of ["workspace/attention", "workspace/attempts"]) {
			const pending = call(route, grant);
			broker.endSession();
			release();
			expect([route, (await pending).status]).toEqual([route, 401]);
		}
	});
});

describe("the overview never shows another launch's evidence", () => {
	it("ignores a projection whose launch is not the one that served the tasks", () => {
		const p = project();
		const failed = taskIn(p.root, p.projectId, "Failed", "in-progress");
		p.check(p.attempt(failed), 1, failing);
		const tasks = p.workspaceTasks();
		const projection = p.view();
		const shown = (launchId: string) => {
			const { evidence, record } = evidenceOf(LAUNCH, {
				view: { ...projection, launchId },
				current: true,
				busy: false,
				problem: null,
			});
			return overviewOf(tasks, evidence, record, projection.taskRevision);
		};
		expect(shown(LAUNCH).attention.map((i) => i.flags[0])).toEqual(["failed"]);
		const other = shown("fedcba9876543210");
		expect(other.evidence).toBe("failed");
		expect(other.attention).toEqual([]);
		// Nothing read yet is "reading", and a workbench without the route is "absent": neither is ever "all clear".
		expect(evidenceOf(LAUNCH, { view: null, current: false, busy: true, problem: null }).evidence).toBe("pending");
		expect(evidenceOf(LAUNCH, { view: null, current: false, busy: false, problem: "absent" }).evidence).toBe(
			"absent",
		);
		expect(evidenceOf(LAUNCH, { view: null, current: false, busy: false, problem: "refused" }).evidence).toBe(
			"failed",
		);
	});
});
