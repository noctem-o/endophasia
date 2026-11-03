// DEVELOP Slice F: verification receipts (docs/designs/develop-verification-receipts.md). The closed record and its derived verdict, the
// write-once store and its problem files, the read-only Git revision observer against real repositories, the check runner against real
// processes, the service end to end (real Git, real commits, HEAD moving), the workbench's read-only view and its gate, and the CLI.
// Temporary stores and repositories only; no Pi, no OMP, no model, no agent: fake `pi`, `omp`, `claude` and `codex` first on PATH prove
// nothing here runs one.
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCheckV0 } from "../adapters/develop/check-runner.ts";
import { GitRevisionObserverV0 } from "../adapters/git/revision-observer.ts";
import { WorkbenchTasksV0 } from "../adapters/pi/workbench-tasks.ts";
import type { EndoDevelopAttemptsViewV1 } from "../protocol/develop-attempts.ts";
import {
	ENDO_RECEIPT_LIMITATION_TEXT_V0,
	ENDO_RECEIPT_LIMITATIONS_V0,
	ENDO_RECEIPT_OUTCOME_LABELS_V0,
	ENDO_RECEIPT_REASON_TEXT_V0,
	ENDO_RECEIPT_RELATION_LABELS_V0,
	type EndoDevelopReceiptV0,
	type EndoReceiptFactsV0,
	endoReceiptRelationV0,
	endoReceiptVerdictV0,
	validateEndoDevelopReceiptV0,
} from "../protocol/develop-receipts.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import {
	type DevelopCheckPlanResultV0,
	DevelopReceiptsServiceV0,
	endoCheckEnvironmentV0,
	resolveEndoCheckExecutableV0,
} from "../runtime/contracts/develop-receipts.ts";
import { type DevelopLaunchHostV0, DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import {
	RECEIPT_LIMITATION_TEXT,
	RECEIPT_OUTCOME_LABELS,
	RECEIPT_REASON_TEXT,
	RECEIPT_RELATION_LABELS,
	readAttempts,
} from "../studio-ui/src/model/attempts-wire.ts";
import { git, haveGit } from "./git-fixtures.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const WRITER = fileURLToPath(new URL("./fixtures/develop-receipts-writer.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-receipts-")));
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const dir = join(base, `${name}-${made}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(r.code);
	return r.value;
};
const CANARY = "CANARY-receipt-argv-7c4e-private";
/** An empty home, so the operator's own Git ignore file does not shape these fixtures. */
const HOME = fresh("home");
const observer = new GitRevisionObserverV0({ env: { HOME } });
const discard = () => new PassThrough().resume();

// Fake agents first on PATH, for the whole file: if anything here ran one, it would leave a mark.
const BIN = fresh("agents");
const AGENT_MARK = join(base, "agent-ran");
for (const name of ["pi", "omp", "claude", "codex"])
	writeFileSync(join(BIN, name), `#!/bin/sh\ntouch ${AGENT_MARK}\n`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH ?? ""}`;
afterAll(() => {
	expect(existsSync(AGENT_MARK)).toBe(false);
	rmSync(base, { recursive: true, force: true });
});

/** A repository with one commit holding `check.sh` (exit 0) and `fail.sh` (exit 1). */
function repo(name = "repo"): string {
	const dir = fresh(name);
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "check.sh"), "exit 0\n");
	writeFileSync(join(dir, "fail.sh"), "echo failing >&2; exit 1\n");
	writeFileSync(join(dir, ".gitignore"), "ignored/\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}
const commit = (dir: string, file: string, text: string) => {
	writeFileSync(join(dir, file), text);
	git(dir, "add", file);
	git(dir, "commit", "-q", "-m", `change ${file}`);
};
const head = (dir: string) => git(dir, "rev-parse", "HEAD").trim();
/** Git, inside a check, with an identity (the check's environment is the test process's). */
const GIT_IN_CHECK = "git -c user.name=c -c user.email=c@example.invalid";

/** A store with a project (registered at a repository) and a selected task with one attempt, and a second project with its own. */
function seeded() {
	const root = fresh("store");
	const project = repo("project");
	const otherRepo = repo("other");
	const tasks = new DevelopTasksStoreV0(root);
	const p = ok(tasks.registerProject({ name: "demo", path: project, observedGitRoot: null }));
	const t = ok(tasks.createTask(p.id, { title: "Fix" }, { select: true }));
	const q = ok(tasks.registerProject({ name: "other", path: otherRepo, observedGitRoot: null }));
	const u = ok(tasks.createTask(q.id, { title: "Other" }, { select: true }));
	const attempts = new DevelopAttemptsStoreV0(root);
	const attemptService = new DevelopAttemptsServiceV0(tasks, attempts);
	const attempt = ok(attemptService.prepare(p.id, t.id, { objective: `run: rm -rf / ; claude --yes ${CANARY}` }));
	const other = ok(attemptService.prepare(q.id, u.id, { objective: "other" }));
	const receipts = new DevelopReceiptsStoreV0(root);
	const service = new DevelopReceiptsServiceV0(tasks, attempts, receipts, {
		observe: (directory, options) => observer.observe(directory, options),
		run: runCheckV0,
		version: "0.0.0-test",
	});
	return {
		root,
		project,
		otherRepo,
		tasks,
		attempts,
		receipts,
		service,
		attemptId: attempt.id,
		otherAttempt: other.id,
		projectId: p.id,
	};
}
type Seeded = ReturnType<typeof seeded>;

/** The task file and every attempt record, byte for byte. */
function recordsOf(root: string): Record<string, string> {
	const out: Record<string, string> = { tasks: readFileSync(join(root, "develop", "tasks.json"), "base64") };
	for (const name of readdirSync(join(root, "develop", "attempts")))
		out[name] = readFileSync(join(root, "develop", "attempts", name), "base64");
	return out;
}

const planned = (r: DevelopCheckPlanResultV0) => {
	if (!r.ok) throw new Error(`refused: ${r.code} ${r.reason ?? ""} ${(r.dirty ?? []).join(",")}`);
	return r.plan;
};
async function check(
	w: Seeded,
	argv: string[],
	extra: { cwd?: string; timeoutMs?: number; interrupt?: AbortSignal } = {},
) {
	const plan = planned(
		await w.service.plan(w.attemptId, {
			argv,
			...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
			...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
		}),
	);
	const done = await w.service.run(plan, {
		stdout: discard(),
		stderr: discard(),
		graceMs: 200,
		pipeWaitMs: 300,
		...(extra.interrupt === undefined ? {} : { interrupt: extra.interrupt }),
	});
	expect(done.written).toBe("created");
	return done.receipt;
}

// ---- the record and its verdict -----------------------------------------------------------------------------------------------------

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const T1 = "a".repeat(40);
function facts(change: Partial<EndoReceiptFactsV0> = {}): EndoReceiptFactsV0 {
	return {
		repository: { worktree: "/w", commonDir: "/w/.git", linked: false },
		revision: { commit: C1, tree: T1, branch: "refs/heads/main" },
		reflog: "compared",
		check: {
			argv: ["npm", "test"],
			executable: "/usr/bin/npm",
			realExecutable: "/usr/lib/npm/cli.js",
			timeoutMs: 600_000,
		},
		execution: { kind: "exited", code: 0 },
		strayProcesses: false,
		escapedProcess: false,
		after: {
			state: "observed",
			sameRepository: true,
			commit: C1,
			tree: T1,
			clean: true,
			reflogsUnchanged: true,
			rulesUnchanged: true,
		},
		...change,
	};
}
function receiptOf(
	change: Partial<EndoReceiptFactsV0> = {},
	attemptId = `endo.attempt.${"0".repeat(32)}`,
): EndoDevelopReceiptV0 {
	const f = facts(change);
	return {
		schemaVersion: "endo.develop-receipt.v0",
		id: `endo.receipt.${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`,
		attemptId,
		projectId: `endo.project.${"0".repeat(32)}`,
		requestedBy: "operator",
		via: "cli",
		observer: { tool: "endo", version: "0.0.0-test" },
		startedAtMs: 1_700_000_000_000,
		endedAtMs: 1_700_000_001_000,
		durationMs: 1000,
		...f,
		output: { stdoutBytes: 10, stderrBytes: 0 },
		...endoReceiptVerdictV0(f),
	};
}
const afterWith = (change: Partial<Extract<EndoReceiptFactsV0["after"], { state: "observed" }>>) => ({
	after: { ...(facts().after as Extract<EndoReceiptFactsV0["after"], { state: "observed" }>), ...change },
});

describe("the verdict follows from the facts alone", () => {
	it("passed only for exit 0 with both observations agreeing and clean; failed only for another code with the same", () => {
		expect(endoReceiptVerdictV0(facts()).outcome).toBe("passed");
		expect(endoReceiptVerdictV0(facts({ execution: { kind: "exited", code: 1 } }))).toMatchObject({
			outcome: "failed",
			reasons: [],
		});
	});

	it("anything else is inconclusive, with every reason that applies, in a fixed order (a failure while the tree changed included)", () => {
		const cases: [Partial<EndoReceiptFactsV0>, string[]][] = [
			[{ execution: { kind: "timed-out" } }, ["timed-out"]],
			[{ execution: { kind: "interrupted" } }, ["interrupted"]],
			[{ execution: { kind: "signaled", signal: "SIGSEGV" } }, ["signaled"]],
			[{ execution: { kind: "output-limit" } }, ["output-limit"]],
			[{ execution: { kind: "spawn-failed" } }, ["spawn-failed"]],
			[{ escapedProcess: true }, ["escaped-process"]],
			[{ after: { state: "unavailable" } }, ["after-unavailable"]],
			[afterWith({ sameRepository: false }), ["repository-changed"]],
			[afterWith({ commit: C2 }), ["head-moved"]],
			[afterWith({ tree: C2 }), ["head-moved"]],
			[afterWith({ clean: false }), ["tree-changed"]],
			[afterWith({ reflogsUnchanged: false }), ["reflog-changed"]],
			[afterWith({ rulesUnchanged: false }), ["rules-changed"]],
			[
				{ ...afterWith({ clean: false, commit: C2 }), execution: { kind: "exited", code: 1 } },
				["head-moved", "tree-changed"],
			],
		];
		for (const [change, reasons] of cases)
			expect(endoReceiptVerdictV0(facts(change)), JSON.stringify(change)).toMatchObject({
				outcome: "inconclusive",
				reasons,
			});
	});

	it("names its limitations: nine always, and the reflog, stray-process and in-tree-executable ones when their fact holds (or is unknown)", () => {
		expect(endoReceiptVerdictV0(facts()).limitations).toEqual(ENDO_RECEIPT_LIMITATIONS_V0.slice(0, 9));
		const all = endoReceiptVerdictV0(
			facts({
				reflog: "unavailable",
				strayProcesses: true,
				check: { argv: ["./t"], executable: "/w/t", realExecutable: "/w/t", timeoutMs: 1000 },
			}),
		).limitations;
		expect(all).toEqual(ENDO_RECEIPT_LIMITATIONS_V0.filter((l) => l !== "stray-processes-not-observable"));
		// Where stray processes cannot be seen (no /proc), that is said: unknown is never recorded as "none".
		expect(endoReceiptVerdictV0(facts({ strayProcesses: null })).limitations).toContain(
			"stray-processes-not-observable",
		);
		expect(endoReceiptVerdictV0(facts({ strayProcesses: null })).limitations).not.toContain(
			"stray-processes-stopped",
		);
	});

	it("the validator re-derives the verdict: a forged 'passed', a dropped reason or a dropped limitation is not a receipt", () => {
		const failed = receiptOf({ execution: { kind: "exited", code: 1 } });
		expect(validateEndoDevelopReceiptV0(failed)).toEqual(failed);
		expect(() => validateEndoDevelopReceiptV0({ ...failed, outcome: "passed" })).toThrow();
		const moved = receiptOf(afterWith({ commit: C2 }));
		expect(() => validateEndoDevelopReceiptV0({ ...moved, reasons: [] })).toThrow();
		expect(() => validateEndoDevelopReceiptV0({ ...moved, outcome: "passed", reasons: [] })).toThrow();
		const good = receiptOf();
		expect(() => validateEndoDevelopReceiptV0({ ...good, limitations: good.limitations.slice(1) })).toThrow();
	});

	it("the validator is closed: unknown members, odd argv, relative paths, bad ids and times are refused", () => {
		const good = receiptOf();
		const bad: unknown[] = [
			{ ...good, extra: 1 },
			{ ...good, output: { ...good.output, stdout: "the check's output" } },
			{ ...good, check: { ...good.check, argv: [] } },
			{ ...good, check: { ...good.check, argv: [""] } },
			{ ...good, check: { ...good.check, argv: ["a\u0000b"] } },
			{ ...good, check: { ...good.check, argv: ["\ud800"] } },
			{ ...good, check: { ...good.check, argv: Array.from({ length: 65 }, () => "x") } },
			{ ...good, check: { ...good.check, executable: "npm" } },
			{ ...good, check: { ...good.check, timeoutMs: 10 } },
			{ ...good, repository: { ...good.repository, worktree: "relative/path" } },
			{ ...good, revision: { ...good.revision, commit: "HEAD" } },
			{ ...good, revision: { ...good.revision, branch: "main" } },
			{ ...good, id: "endo.receipt.x" },
			{ ...good, attemptId: "../../etc" },
			{ ...good, endedAtMs: good.startedAtMs - 1 },
			{ ...good, execution: { kind: "exited", code: 256 } },
			{ ...good, execution: { kind: "exited", code: 0, signal: "SIGKILL" } },
			{ ...good, requestedBy: "agent" },
			{ ...good, schemaVersion: "endo.develop-receipt.v1" },
		];
		for (const value of bad)
			expect(() => validateEndoDevelopReceiptV0(value), JSON.stringify(value).slice(0, 120)).toThrow();
	});

	it("relates a receipt to the reader's tree: same commit, changed since, stale, another tree or repository, or unavailable", () => {
		const r = receiptOf();
		const here = { worktree: "/w", commonDir: "/w/.git", commit: C1, clean: true };
		expect(endoReceiptRelationV0(r, here)).toBe("at-head");
		expect(endoReceiptRelationV0(r, { ...here, clean: false })).toBe("at-head-changed");
		expect(endoReceiptRelationV0(r, { ...here, commit: C2 })).toBe("head-differs");
		expect(endoReceiptRelationV0(r, { ...here, worktree: "/w2" })).toBe("other-worktree");
		expect(endoReceiptRelationV0(r, { ...here, commonDir: "/x/.git" })).toBe("other-repository");
		expect(endoReceiptRelationV0(r, null)).toBe("unavailable");
	});

	it("no label says 'verified', names the task or the agent, or calls a receipt acceptance; the page's words are the protocol's", () => {
		for (const text of [
			...Object.values(ENDO_RECEIPT_OUTCOME_LABELS_V0),
			...Object.values(ENDO_RECEIPT_RELATION_LABELS_V0),
			...Object.values(ENDO_RECEIPT_REASON_TEXT_V0),
		])
			expect(text).not.toMatch(/verified|accept|agent succeeded|task (is )?(done|complete)/i);
		expect(RECEIPT_OUTCOME_LABELS).toEqual(ENDO_RECEIPT_OUTCOME_LABELS_V0);
		expect(RECEIPT_REASON_TEXT).toEqual(ENDO_RECEIPT_REASON_TEXT_V0);
		expect(RECEIPT_LIMITATION_TEXT).toEqual(ENDO_RECEIPT_LIMITATION_TEXT_V0);
		expect(RECEIPT_RELATION_LABELS).toEqual(ENDO_RECEIPT_RELATION_LABELS_V0);
	});
});

// ---- the store ----------------------------------------------------------------------------------------------------------------------

describe("the receipts store", () => {
	const A = `endo.attempt.${"a".repeat(32)}`;
	const dirOf = (root: string, attemptId = A) => join(root, "develop", "receipts", attemptId);

	it("writes owner-only files once, keeps a failure beside the pass that followed it, and reads the same after a restart", () => {
		const root = fresh("store");
		const store = new DevelopReceiptsStoreV0(root);
		const failed = receiptOf({ execution: { kind: "exited", code: 1 } }, A);
		const passed = {
			...receiptOf({}, A),
			startedAtMs: failed.startedAtMs + 5000,
			endedAtMs: failed.endedAtMs + 5000,
		};
		expect(store.write(failed)).toBe("created");
		expect(store.write(passed)).toBe("created");
		// The same id again: the first is left as it was.
		const bytes = readFileSync(join(dirOf(root), `${failed.id}.json`));
		expect(store.write({ ...failed, durationMs: 1 })).toBe("failed");
		expect(readFileSync(join(dirOf(root), `${failed.id}.json`))).toEqual(bytes);
		const read = new DevelopReceiptsStoreV0(root).read(A);
		expect(read).toEqual({ ok: true, receipts: [failed, passed], problems: [] });
		expect(statSync(dirOf(root)).mode & 0o777).toBe(0o700);
		expect(statSync(join(dirOf(root), `${failed.id}.json`)).mode & 0o777).toBe(0o600);
		expect(new DevelopReceiptsStoreV0(root).read(`endo.attempt.${"b".repeat(32)}`)).toEqual({
			ok: true,
			receipts: [],
			problems: [],
		});
	});

	it("refuses to write a receipt whose verdict does not follow from its facts, or an id that is not one", () => {
		const store = new DevelopReceiptsStoreV0(fresh("store"));
		expect(store.write({ ...receiptOf({ execution: { kind: "exited", code: 1 } }, A), outcome: "passed" })).toBe(
			"failed",
		);
		expect(store.write({ ...receiptOf({}, "../x" as string) })).toBe("failed");
	});

	it("reports missing-, corrupt-, oversize-, misnamed-, symlinked-, unknown- and forged-file problems by name, leaving each as found", () => {
		const root = fresh("store");
		const store = new DevelopReceiptsStoreV0(root);
		const good = receiptOf({}, A);
		expect(store.write(good)).toBe("created");
		const dir = dirOf(root);
		const target = fresh("elsewhere");
		const outside = join(target, "r.json");
		writeFileSync(outside, JSON.stringify(receiptOf({}, A)));
		const names = {
			corrupt: `endo.receipt.${"1".repeat(32)}.json`,
			oversize: `endo.receipt.${"2".repeat(32)}.json`,
			misnamed: `endo.receipt.${"3".repeat(32)}.json`,
			linked: `endo.receipt.${"4".repeat(32)}.json`,
			forged: `endo.receipt.${"5".repeat(32)}.json`,
			otherAttempt: `endo.receipt.${"6".repeat(32)}.json`,
			unknown: "notes.txt",
		};
		writeFileSync(join(dir, names.corrupt), "{ not json");
		writeFileSync(join(dir, names.oversize), " ".repeat(70 * 1024));
		writeFileSync(join(dir, names.misnamed), JSON.stringify(good));
		symlinkSync(outside, join(dir, names.linked));
		const forgedReceipt = {
			...receiptOf({ execution: { kind: "exited", code: 1 } }, A),
			id: `endo.receipt.${"5".repeat(32)}`,
		};
		writeFileSync(join(dir, names.forged), JSON.stringify({ ...forgedReceipt, outcome: "passed" }));
		const otherAttempt = receiptOf({}, `endo.attempt.${"c".repeat(32)}`);
		writeFileSync(
			join(dir, names.otherAttempt),
			JSON.stringify({ ...otherAttempt, id: `endo.receipt.${"6".repeat(32)}` }),
		);
		writeFileSync(join(dir, names.unknown), "hello");
		const before = Object.fromEntries(
			readdirSync(dir).map((n) => [
				n,
				lstatSync(join(dir, n)).isSymbolicLink() ? "link" : readFileSync(join(dir, n), "base64"),
			]),
		);
		const read = store.read(A);
		if (!read.ok) throw new Error(read.reason);
		expect(read.receipts).toEqual([good]);
		expect(Object.fromEntries(read.problems.map((p) => [p.name, p.reason]))).toEqual({
			[names.corrupt]: "malformed",
			[names.oversize]: "too-large",
			[names.misnamed]: "misnamed",
			[names.linked]: "unsafe-path",
			[names.forged]: "invalid",
			[names.otherAttempt]: "misnamed",
			[names.unknown]: "unknown-file",
		});
		const after_ = Object.fromEntries(
			readdirSync(dir).map((n) => [
				n,
				lstatSync(join(dir, n)).isSymbolicLink() ? "link" : readFileSync(join(dir, n), "base64"),
			]),
		);
		expect(after_).toEqual(before);
	});

	it("refuses a symlinked receipts or attempt directory, and an attempt id that could name a path", () => {
		const root = fresh("store");
		const store = new DevelopReceiptsStoreV0(root);
		mkdirSync(join(root, "develop", "receipts"), { recursive: true });
		const elsewhere = fresh("elsewhere");
		symlinkSync(elsewhere, dirOf(root));
		expect(store.read(A)).toEqual({ ok: false, reason: "unsafe-path" });
		expect(store.write(receiptOf({}, A))).toBe("unsafe-path");
		expect(readdirSync(elsewhere)).toEqual([]);
		expect(store.read("../../tasks")).toEqual({ ok: false, reason: "unsafe-path" });
		const root2 = fresh("store");
		mkdirSync(join(root2, "develop"), { recursive: true });
		symlinkSync(elsewhere, join(root2, "develop", "receipts"));
		expect(new DevelopReceiptsStoreV0(root2).write(receiptOf({}, A))).toBe("unsafe-path");
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	it("a crash before the link leaves no receipt; its temporary file is never read and is swept once it is old", () => {
		const root = fresh("store");
		const crashing = new DevelopReceiptsStoreV0(root, {
			beforeLink: () => {
				throw new Error("crash");
			},
		});
		expect(crashing.write(receiptOf({}, A))).toBe("failed");
		expect(readdirSync(dirOf(root))).toEqual([]);
		// A real crash removes nothing: a temporary file is left. Readers skip it; the next writer removes it once it is a minute old.
		const leftover = join(dirOf(root), ".tmp-99999-0123456789ab");
		writeFileSync(leftover, JSON.stringify(receiptOf({}, A)));
		const store = new DevelopReceiptsStoreV0(root);
		expect(store.read(A)).toEqual({ ok: true, receipts: [], problems: [] });
		const young = receiptOf({}, A);
		expect(store.write(young)).toBe("created");
		expect(existsSync(leftover)).toBe(true);
		utimesSync(leftover, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
		expect(store.write(receiptOf({}, A))).toBe("created");
		expect(existsSync(leftover)).toBe(false);
	});

	it("concurrent writers from several processes each record their own receipt; none is lost or merged", async () => {
		const root = fresh("store");
		const go = join(base, `go-${made}`);
		const receipts = Array.from({ length: 6 }, (_, i) => ({
			...receiptOf({ execution: { kind: "exited", code: i % 2 } }, A),
			id: `endo.receipt.${String(i).repeat(32)}`,
		}));
		const children = receipts.map((r, i) => {
			const file = join(base, `receipt-${made}-${i}.json`);
			writeFileSync(file, JSON.stringify(r));
			const child = spawn(process.execPath, [WRITER, root, file, go], { stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			child.stdout.on("data", (chunk: Buffer) => {
				out += chunk.toString();
			});
			return { child, output: () => out };
		});
		while (!children.every((c) => c.output().includes("ready"))) await new Promise((r) => setTimeout(r, 20));
		writeFileSync(go, "");
		await Promise.all(children.map((c) => new Promise((r) => c.child.on("close", r))));
		expect(children.map((c) => c.output().trim().split("\n").at(-1))).toEqual(receipts.map(() => "created"));
		const read = new DevelopReceiptsStoreV0(root).read(A);
		if (!read.ok) throw new Error(read.reason);
		expect(read.problems).toEqual([]);
		expect(read.receipts.map((r) => r.id).sort()).toEqual(receipts.map((r) => r.id).sort());
	}, 60_000);
});

// ---- the Git observer, against real repositories ------------------------------------------------------------------------------------

describe.skipIf(!haveGit)("the revision observer", () => {
	const observe = async (dir: string, within = false) => observer.observe(dir, { within });
	const seen = async (dir: string) => {
		const r = await observe(dir);
		if (!r.ok) throw new Error(r.reason);
		return r.observation;
	};

	it("names the commit and tree of a clean tree on a branch, and on a detached HEAD", async () => {
		const dir = repo();
		const o = await seen(dir);
		expect(o).toMatchObject({
			worktree: dir,
			commonDir: join(dir, ".git"),
			linked: false,
			branch: "refs/heads/main",
			dirty: [],
		});
		expect(o.commit).toBe(head(dir));
		expect(o.tree).toBe(git(dir, "rev-parse", "HEAD^{tree}").trim());
		expect(o.reflogs.head).not.toBeNull();
		git(dir, "checkout", "-q", "--detach");
		expect(await seen(dir)).toMatchObject({ branch: null, dirty: [], commit: o.commit });
	});

	it("sees staged, unstaged, untracked and deleted changes, but not ignored files", async () => {
		const dir = repo();
		mkdirSync(join(dir, "ignored"));
		writeFileSync(join(dir, "ignored", "build.out"), "x");
		expect((await seen(dir)).dirty).toEqual([]);
		for (const make of [
			() => writeFileSync(join(dir, "new.txt"), "x"),
			() => writeFileSync(join(dir, "check.sh"), "exit 3\n"),
			() => {
				writeFileSync(join(dir, "check.sh"), "exit 4\n");
				git(dir, "add", "check.sh");
			},
			() => rmSync(join(dir, "check.sh")),
		]) {
			make();
			expect((await seen(dir)).dirty).toEqual(["changes"]);
			git(dir, "reset", "-q", "--hard");
			git(dir, "clean", "-q", "-f");
			expect((await seen(dir)).dirty).toEqual([]);
		}
	});

	it("sees index entries that hide changes (assume-unchanged, skip-worktree) and submodules, which status alone would not", async () => {
		const dir = repo();
		git(dir, "update-index", "--assume-unchanged", "check.sh");
		writeFileSync(join(dir, "check.sh"), "exit 9\n");
		expect(git(dir, "status", "--porcelain")).toBe("");
		expect((await seen(dir)).dirty).toEqual(["flagged-entries"]);
		const dir2 = repo();
		git(dir2, "update-index", "--skip-worktree", "fail.sh");
		expect((await seen(dir2)).dirty).toEqual(["flagged-entries"]);
		const dir3 = repo();
		git(dir3, "update-index", "--add", "--cacheinfo", `160000,${head(dir3)},sub`);
		git(dir3, "commit", "-q", "-m", "gitlink");
		expect((await seen(dir3)).dirty).toEqual(["submodule"]);
	});

	it("refuses a subdirectory unless asked to look within, a bare repository, an unborn branch and a non-repository", async () => {
		const dir = repo();
		mkdirSync(join(dir, "sub"));
		expect(await observe(join(dir, "sub"))).toEqual({ ok: false, reason: "not-top-level" });
		expect(await observe(join(dir, "sub"), true)).toMatchObject({ ok: true, observation: { worktree: dir } });
		const bare = fresh("bare");
		git(bare, "init", "-q", "--bare");
		expect(await observe(bare)).toEqual({ ok: false, reason: "bare-repository" });
		const unborn = fresh("unborn");
		git(unborn, "init", "-q");
		expect(await observe(unborn)).toEqual({ ok: false, reason: "unborn" });
		expect(await observe(fresh("plain"))).toEqual({ ok: false, reason: "not-a-repository" });
		expect(await observe(join(base, "no-such-dir"))).toEqual({ ok: false, reason: "no-directory" });
	});

	it("observes a linked worktree as linked, sharing the common directory, with its own HEAD", async () => {
		const dir = repo();
		const linked = join(fresh("linked-parent"), "wt");
		git(dir, "worktree", "add", "-q", "-b", "side", linked);
		const o = await seen(linked);
		expect(o).toMatchObject({
			worktree: linked,
			commonDir: join(dir, ".git"),
			linked: true,
			branch: "refs/heads/side",
			dirty: [],
		});
	});

	it("a repository that writes no reflog has none to compare: null, never a value that looks compared", async () => {
		const dir = fresh("nolog");
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "core.logAllRefUpdates", "false");
		writeFileSync(join(dir, "check.sh"), "exit 0\n");
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "init");
		rmSync(join(dir, ".git", "logs"), { recursive: true, force: true });
		expect((await seen(dir)).reflogs).toEqual({ head: null, branch: null });
	});

	it("its reflog and rules values change when a commit is made, or info/exclude is edited", async () => {
		const dir = repo();
		const a = await seen(dir);
		commit(dir, "x.txt", "x");
		const b = await seen(dir);
		expect(b.reflogs.head).not.toBe(a.reflogs.head);
		expect(b.reflogs.branch).not.toBe(a.reflogs.branch);
		expect(b.rules).toBe(a.rules);
		writeFileSync(join(dir, ".git", "info", "exclude"), "hidden\n");
		expect((await seen(dir)).rules).not.toBe(b.rules);
	});

	it("runs no repository program: a filter and an fsmonitor hook in the repository's configuration are never started", async () => {
		const dir = repo();
		const mark = join(base, `repo-program-${made}`);
		const program = join(fresh("prog"), "p.sh");
		writeFileSync(program, `#!/bin/sh\ntouch ${mark}\ncat\n`, { mode: 0o755 });
		git(dir, "config", "filter.evil.clean", program);
		git(dir, "config", "core.fsmonitor", program);
		writeFileSync(join(dir, ".gitattributes"), "* filter=evil\n");
		git(dir, "add", ".gitattributes");
		git(dir, "-c", "filter.evil.clean=cat", "-c", "core.fsmonitor=false", "commit", "-q", "-m", "attrs");
		writeFileSync(join(dir, "check.sh"), "exit 5\n");
		// The fixture's own Git (which honours the repository's configuration) may have run it; only what follows counts.
		rmSync(mark, { force: true });
		const r = await observe(dir);
		expect(r.ok && r.observation.dirty).toEqual(["changes"]);
		expect(existsSync(mark)).toBe(false);
	});
});

// ---- the runner, against real processes ---------------------------------------------------------------------------------------------

describe("the check runner", () => {
	const run = (args: string[], change: Partial<Parameters<typeof runCheckV0>[0]> = {}) =>
		runCheckV0({
			executable: "/bin/sh",
			args,
			cwd: base,
			env: { PATH: process.env.PATH ?? "" },
			timeoutMs: 5_000,
			maxOutputBytes: 1024 * 1024,
			stdout: discard(),
			stderr: discard(),
			graceMs: 200,
			pipeWaitMs: 300,
			...change,
		});

	it("passes output through as it comes, counts it, and keeps none of it; binary output is only bytes", async () => {
		const out = new PassThrough();
		let seenOut = Buffer.alloc(0);
		out.on("data", (c: Buffer) => {
			seenOut = Buffer.concat([seenOut, c]);
		});
		const r = await run(["-c", "printf 'a\\000\\377b'; printf err >&2"], { stdout: out });
		expect(r).toMatchObject({ execution: { kind: "exited", code: 0 }, output: { stdoutBytes: 4, stderrBytes: 3 } });
		expect(seenOut).toEqual(Buffer.from([0x61, 0, 0xff, 0x62]));
	});

	it("gives the check no input: a command that reads stdin sees its end at once", async () => {
		expect((await run(["-c", "cat; exit 0"])).execution).toEqual({ kind: "exited", code: 0 });
	});

	it("stops a check at its time limit (SIGTERM, then SIGKILL for one that ignores it), and at the output limit", async () => {
		expect((await run(["-c", "sleep 20"], { timeoutMs: 300 })).execution).toEqual({ kind: "timed-out" });
		const stubborn = await run(["-c", "trap '' TERM; sleep 20"], { timeoutMs: 300 });
		expect(stubborn.execution).toEqual({ kind: "timed-out" });
		expect(stubborn.durationMs).toBeLessThan(5_000);
		expect((await run(["-c", "yes"], { maxOutputBytes: 10_000 })).execution).toEqual({ kind: "output-limit" });
	});

	it("reports a signal it did not send, a missing or unrunnable executable, and an interruption", async () => {
		expect((await run(["-c", "kill -KILL $$"])).execution).toEqual({ kind: "signaled", signal: "SIGKILL" });
		expect((await run([], { executable: join(base, "no-such-executable") })).execution).toEqual({
			kind: "spawn-failed",
		});
		const badShebang = join(fresh("bin"), "t");
		writeFileSync(badShebang, "#!/no/such/interpreter\n", { mode: 0o755 });
		expect((await run([], { executable: badShebang })).execution).toEqual({ kind: "spawn-failed" });
		const interrupt = new AbortController();
		setTimeout(() => interrupt.abort(), 200);
		expect((await run(["-c", "sleep 20"], { interrupt: interrupt.signal })).execution).toEqual({
			kind: "interrupted",
		});
	});

	it("a sink that fails (the terminal closed) does not end the run: the check is still observed and counted", async () => {
		const failing = new Writable({
			write(_chunk, _encoding, callback) {
				callback(new Error("EPIPE"));
			},
		});
		const r = await run(["-c", "for i in 1 2 3 4 5; do echo line; sleep 0.05; done; exit 0"], {
			stdout: failing,
			stderr: failing,
		});
		expect(r).toMatchObject({ execution: { kind: "exited", code: 0 }, escapedProcess: false });
		expect(r.output.stdoutBytes).toBe(25);
	});

	it("a sink that never drains holds the check back while it runs, but is never taken for an escaped process", async () => {
		const stuck = new Writable({ highWaterMark: 16, write() {} });
		const r = await run(["-c", "head -c 300000 /dev/zero; exit 0"], { stdout: stuck, timeoutMs: 2_000 });
		// The pipe filled and the command waited on it: stopped at its time limit, all inside its group; nothing escaped.
		expect(r).toMatchObject({ execution: { kind: "timed-out" }, escapedProcess: false });
	});

	it("stops processes the check left in its group, and notes them; a process that left the group and holds the output is 'escaped'", async () => {
		const pidFile = join(base, `stray-${made}`);
		const stray = await run(["-c", `sleep 30 & echo $! > ${pidFile}; exit 0`]);
		expect(stray).toMatchObject({
			execution: { kind: "exited", code: 0 },
			strayProcesses: true,
			escapedProcess: false,
		});
		const pid = Number(readFileSync(pidFile, "utf8"));
		const alive = (() => {
			try {
				process.kill(pid, 0);
				return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
			} catch {
				return false;
			}
		})();
		expect(alive).toBe(false);
		// The child reports once it has left the group, so the check never exits before the escape happened.
		const ready = join(base, `escaped-${made}`);
		const escaped = await run([
			"-c",
			`setsid sh -c 'touch ${ready}; sleep 3' & while [ ! -e ${ready} ]; do sleep 0.01; done; exit 0`,
		]);
		expect(escaped).toMatchObject({ execution: { kind: "exited", code: 0 }, escapedProcess: true });
	});
});

// ---- the service end to end, with real Git ------------------------------------------------------------------------------------------

describe.skipIf(!haveGit)("checks against a real repository", () => {
	it("a passing check at a clean commit, then a commit: the receipt is kept and now stale, never carried forward", async () => {
		const w = seeded();
		const before = recordsOf(w.root);
		const r = await check(w, ["sh", "check.sh"]);
		expect(r).toMatchObject({
			outcome: "passed",
			reasons: [],
			execution: { kind: "exited", code: 0 },
			revision: { commit: head(w.project), branch: "refs/heads/main" },
			repository: { worktree: w.project, linked: false },
			check: { argv: ["sh", "check.sh"] },
			reflog: "compared",
		});
		const current = await w.service.current(w.project);
		expect(ok({ ok: true, value: w.service.list(w.attemptId, current) }).ok).toBe(true);
		const list = w.service.list(w.attemptId, current);
		if (!list.ok) throw new Error(list.code);
		expect(list.receipts.map((x) => x.relation)).toEqual(["at-head"]);
		writeFileSync(join(w.project, "scratch.txt"), "edit");
		const dirty = w.service.list(w.attemptId, await w.service.current(w.project));
		expect(dirty.ok && dirty.receipts.map((x) => x.relation)).toEqual(["at-head-changed"]);
		rmSync(join(w.project, "scratch.txt"));
		// A commit with the same tree (an amend of the message) is still a different revision.
		git(w.project, "commit", "-q", "--amend", "-m", "same tree, new commit");
		const stale = w.service.list(w.attemptId, await w.service.current(w.project));
		expect(stale.ok && stale.receipts.map((x) => [x.receipt.outcome, x.relation])).toEqual([
			["passed", "head-differs"],
		]);
		expect(recordsOf(w.root)).toEqual(before);
	});

	it("a failing check is recorded as failed and kept when a passing one follows", async () => {
		const w = seeded();
		const failed = await check(w, ["sh", "fail.sh"]);
		expect(failed).toMatchObject({ outcome: "failed", execution: { kind: "exited", code: 1 }, reasons: [] });
		commit(w.project, "fail.sh", "exit 0\n");
		const passed = await check(w, ["sh", "fail.sh"]);
		expect(passed.outcome).toBe("passed");
		const list = w.service.list(w.attemptId, await w.service.current(w.project));
		if (!list.ok) throw new Error(list.code);
		expect(list.receipts.map((x) => [x.receipt.id, x.receipt.outcome, x.relation])).toEqual([
			[failed.id, "failed", "head-differs"],
			[passed.id, "passed", "at-head"],
		]);
	});

	it("a check that changes the repository while it runs is inconclusive, with the reason, whatever it exits with", async () => {
		const w = seeded();
		expect(await check(w, ["sh", "-c", "echo x >> check.sh"])).toMatchObject({
			outcome: "inconclusive",
			reasons: ["tree-changed"],
			execution: { kind: "exited", code: 0 },
		});
		git(w.project, "checkout", "-q", "--", "check.sh");
		expect((await check(w, ["sh", "-c", "echo x > untracked.txt; exit 1"])).reasons).toEqual(["tree-changed"]);
		rmSync(join(w.project, "untracked.txt"));
		const committed = await check(w, [
			"sh",
			"-c",
			`echo y > y.txt && ${GIT_IN_CHECK} add y.txt && ${GIT_IN_CHECK} commit -q -m y`,
		]);
		expect(committed.outcome).toBe("inconclusive");
		expect(committed.reasons).toEqual(expect.arrayContaining(["head-moved", "reflog-changed"]));
		// HEAD moved and came back: the commit and tree agree, but the reflog shows it.
		const there = head(w.project);
		const back = await check(w, [
			"sh",
			"-c",
			`${GIT_IN_CHECK} checkout -q HEAD~1 && ${GIT_IN_CHECK} checkout -q ${there}`,
		]);
		expect(back.reasons).toEqual(["reflog-changed"]);
		git(w.project, "checkout", "-q", "main");
		// A check that hides its own output by adding an ignore rule: clean afterwards, but under different rules.
		const hidden = await check(w, ["sh", "-c", "echo out > made.txt && echo made.txt >> .git/info/exclude"]);
		expect(hidden.reasons).toEqual(["rules-changed"]);
		// ...or a nested .gitignore that ignores itself and the file the check made: no change shows in Git's status, but the rules moved.
		mkdirSync(join(w.project, "sub"));
		const nested = await check(w, ["sh", "-c", "printf '*\\n' > sub/.gitignore && echo evil > sub/payload.js"]);
		expect([nested.outcome, nested.reasons]).toEqual(["inconclusive", ["rules-changed"]]);
		expect(git(w.project, "status", "--porcelain")).toBe("");
		// ...or Git's default user ignore file, when none is configured.
		const userIgnore = join(HOME, ".config", "git", "ignore");
		try {
			const viaHome = await check(w, [
				"sh",
				"-c",
				`mkdir -p ${join(HOME, ".config", "git")} && echo payload2.js > ${userIgnore} && echo evil > payload2.js`,
			]);
			expect([viaHome.outcome, viaHome.reasons]).toEqual(["inconclusive", ["rules-changed"]]);
		} finally {
			rmSync(join(HOME, ".config"), { recursive: true, force: true });
			rmSync(join(w.project, "payload2.js"), { force: true });
		}
		// ...or an ignore file that is a symbolic link: Git reads its target, so the target's change is the rules' change.
		const target = join(fresh("ignore-target"), "ignore");
		writeFileSync(target, "");
		const link = join(fresh("ignore-link"), "ignore");
		symlinkSync(target, link);
		git(w.project, "config", "core.excludesFile", link);
		const viaLink = await check(w, ["sh", "-c", `echo payload3.js >> ${target} && echo evil > payload3.js`]);
		expect([viaLink.outcome, viaLink.reasons]).toEqual(["inconclusive", ["rules-changed"]]);
	});

	it("a check in a repository that writes no reflog says so: reflog unavailable, with its limitation", async () => {
		const w = seeded();
		git(w.project, "config", "core.logAllRefUpdates", "false");
		rmSync(join(w.project, ".git", "logs"), { recursive: true, force: true });
		const r = await check(w, ["sh", "check.sh"]);
		expect([r.outcome, r.reflog]).toEqual(["passed", "unavailable"]);
		expect(r.limitations).toContain("reflog-unavailable");
	});

	it("a timeout, an interruption, a signal and an unstartable executable are recorded honestly, never as passed", async () => {
		const w = seeded();
		expect(await check(w, ["sleep", "20"], { timeoutMs: 1000 })).toMatchObject({
			outcome: "inconclusive",
			reasons: ["timed-out"],
		});
		const interrupt = new AbortController();
		setTimeout(() => interrupt.abort(), 300);
		expect(await check(w, ["sleep", "20"], { interrupt: interrupt.signal })).toMatchObject({
			outcome: "inconclusive",
			reasons: ["interrupted"],
			execution: { kind: "interrupted" },
		});
		expect((await check(w, ["sh", "-c", "kill -TERM $$"])).reasons).toEqual(["signaled"]);
		const tool = join(fresh("tools"), "broken-tool");
		writeFileSync(tool, "#!/no/such/interpreter\n", { mode: 0o755 });
		expect((await check(w, [tool])).reasons).toEqual(["spawn-failed"]);
		const list = w.service.list(w.attemptId, null);
		expect(list.ok && list.receipts.map((x) => x.receipt.outcome)).toEqual(Array(4).fill("inconclusive"));
	});

	it("refuses, running nothing and recording nothing: dirty or flagged trees, a subdirectory, another repository, a missing executable", async () => {
		const w = seeded();
		const mark = join(base, `ran-${made}`);
		const argv = ["sh", "-c", `touch ${mark}`];
		const refusal = async (change: { cwd?: string; argv?: unknown; timeoutMs?: number }, attemptId = w.attemptId) => {
			const r = await w.service.plan(attemptId, { argv, ...change });
			return r.ok ? "planned" : [r.code, ...(r.dirty ?? [])].join(":");
		};
		writeFileSync(join(w.project, "untracked.txt"), "x");
		expect(await refusal({})).toBe("not-clean:changes");
		rmSync(join(w.project, "untracked.txt"));
		writeFileSync(join(w.project, "check.sh"), "exit 0 # edited\n");
		git(w.project, "add", "check.sh");
		expect(await refusal({})).toBe("not-clean:changes");
		git(w.project, "reset", "-q", "--hard");
		git(w.project, "update-index", "--skip-worktree", "fail.sh");
		expect(await refusal({})).toBe("not-clean:flagged-entries");
		git(w.project, "update-index", "--no-skip-worktree", "fail.sh");
		mkdirSync(join(w.project, "sub"), { recursive: true });
		expect(await refusal({ cwd: join(w.project, "sub") })).toBe("repository");
		// Another project's repository, or a plain directory, is not this attempt's.
		expect(await refusal({ cwd: w.otherRepo })).toBe("other-repository");
		expect(await refusal({ cwd: fresh("plain") })).toBe("repository");
		expect(await refusal({ argv: ["no-such-tool-for-endo-xyz"] })).toBe("executable-not-found");
		expect(await refusal({ argv: [] })).toBe("bad-request");
		expect(await refusal({ argv: "sh -c true" })).toBe("bad-request");
		expect(await refusal({ timeoutMs: 10 })).toBe("bad-request");
		expect(await refusal({}, "endo.attempt.not-an-id")).toBe("bad-request");
		expect(await refusal({}, `endo.attempt.${"e".repeat(32)}`)).toBe("not-found");
		expect(await refusal({ argv: ["sh", "x".repeat(9000)] })).toBe("bad-request");
		const windows = new DevelopReceiptsServiceV0(w.tasks, w.attempts, w.receipts, {
			observe: (d, o) => observer.observe(d, o),
			run: runCheckV0,
			version: "0.0.0-test",
			platform: "win32",
		});
		expect((await windows.plan(w.attemptId, { argv })).ok).toBe(false);
		expect(existsSync(mark)).toBe(false);
		expect(existsSync(join(w.root, "develop", "receipts"))).toBe(false);
	});

	it("checks a linked worktree of the project's repository, and relates its receipt only to that worktree", async () => {
		const w = seeded();
		const linked = join(fresh("linked"), "wt");
		git(w.project, "worktree", "add", "-q", "--detach", linked);
		const r = await check(w, ["sh", "check.sh"], { cwd: linked });
		expect(r).toMatchObject({
			outcome: "passed",
			repository: { worktree: linked, linked: true },
			revision: { branch: null },
		});
		const fromMain = w.service.list(w.attemptId, await w.service.current(w.project));
		expect(fromMain.ok && fromMain.receipts.map((x) => x.relation)).toEqual(["other-worktree"]);
		const fromOther = w.service.list(w.attemptId, await w.service.current(w.otherRepo));
		expect(fromOther.ok && fromOther.receipts.map((x) => x.relation)).toEqual(["other-repository"]);
		const fromLinked = w.service.list(w.attemptId, await w.service.current(linked));
		expect(fromLinked.ok && fromLinked.receipts.map((x) => x.relation)).toEqual(["at-head"]);
	});

	it("two checks at once on one attempt are recorded independently", async () => {
		const w = seeded();
		const [a, b] = await Promise.all([check(w, ["sh", "check.sh"]), check(w, ["sh", "fail.sh"])]);
		expect([a.outcome, b.outcome]).toEqual(["passed", "failed"]);
		const list = w.service.list(w.attemptId, null);
		expect(list.ok && list.receipts.map((x) => x.receipt.id).sort()).toEqual([a.id, b.id].sort());
	});

	it("a check whose receipt could not be recorded (a branch name over the bound) is refused before it runs", async () => {
		const w = seeded();
		const long = Array.from({ length: 5 }, (_, i) => `${i}${"b".repeat(239)}`).join("/");
		git(w.project, "checkout", "-q", "-b", long);
		const mark = join(base, `ran-${made}`);
		const r = await w.service.plan(w.attemptId, { argv: ["sh", "-c", `touch ${mark}`] });
		expect(r.ok ? "planned" : r.code).toBe("unrecordable");
		expect(existsSync(mark)).toBe(false);
	});

	it("the receipt cap is checked before anything runs", async () => {
		const w = seeded();
		const dir = join(w.root, "develop", "receipts", w.attemptId);
		for (let i = 0; i < 100; i += 1) expect(w.receipts.write(receiptOf({}, w.attemptId))).toBe("created");
		expect(readdirSync(dir)).toHaveLength(100);
		const r = await w.service.plan(w.attemptId, { argv: ["sh", "check.sh"] });
		expect(r.ok ? "planned" : r.code).toBe("limit");
	});
});

describe("what a check may run", () => {
	it("looks a bare name up along PATH, skipping empty, relative and in-tree entries; a path is taken as given; links are not followed", () => {
		const tree = fresh("tree");
		const inTree = join(tree, "node_modules", ".bin");
		mkdirSync(inTree, { recursive: true });
		const outside = fresh("outside-bin");
		const realDir = fresh("real-bin");
		writeFileSync(join(inTree, "tool"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(realDir, "multi"), "#!/bin/sh\n", { mode: 0o755 });
		symlinkSync(join(realDir, "multi"), join(outside, "tool"));
		writeFileSync(join(outside, "plain"), "not executable", { mode: 0o644 });
		const path = ["", ".", "node_modules/.bin", inTree, outside].join(":");
		expect(resolveEndoCheckExecutableV0("tool", tree, path)).toEqual({
			executable: join(outside, "tool"),
			realExecutable: join(realDir, "multi"),
		});
		expect(resolveEndoCheckExecutableV0("tool", tree, ["", ".", inTree].join(":"))).toBeNull();
		expect(resolveEndoCheckExecutableV0("plain", tree, outside)).toBeNull();
		expect(resolveEndoCheckExecutableV0("./node_modules/.bin/tool", tree, "")).toEqual({
			executable: join(inTree, "tool"),
			realExecutable: join(inTree, "tool"),
		});
	});

	it("removes the variables that would point the check's own Git elsewhere, and keeps the rest", () => {
		const env = endoCheckEnvironmentV0({
			PATH: "/bin",
			HOME: "/h",
			GIT_DIR: "/elsewhere/.git",
			GIT_WORK_TREE: "/elsewhere",
			GIT_INDEX_FILE: "/i",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: "/x",
			GIT_AUTHOR_NAME: "kept",
		});
		expect(env).toEqual({ PATH: "/bin", HOME: "/h", GIT_AUTHOR_NAME: "kept" });
	});
});

// ---- the workbench: read-only, behind the grant, no path, no execution ---------------------------------------------------------------

describe.skipIf(!haveGit)("the workbench's view of receipts", () => {
	const host: DevelopLaunchHostV0 = { launchId: "f".repeat(16), attachment: "pi.default", session: null };
	const routes = (w: Seeded, launchDirectory: string) =>
		new WorkbenchTasksV0(
			new DevelopWorkspaceServiceV0(w.tasks, {
				attempts: w.attempts,
				receipts: { store: w.receipts, current: (d) => w.service.current(d) },
			}).forLaunch({ projectId: w.projectId, launchDirectory }, host),
		);

	it("shows each attempt's receipts related to the launch directory's HEAD, with no path, through the closed gate", async () => {
		const w = seeded();
		const r = await check(w, ["sh", "check.sh", CANARY]);
		const reply = await routes(w, w.project).route(["workspace", "attempts"], "GET", "", null);
		expect(reply.status).toBe(200);
		const view = reply.body as EndoDevelopAttemptsViewV1;
		const attempt = view.attempts.find((a) => a.id === w.attemptId);
		expect(attempt?.receipts).toEqual({
			state: "ready",
			problems: 0,
			list: [
				{
					id: r.id,
					startedAtMs: r.startedAtMs,
					endedAtMs: r.endedAtMs,
					argv: ["sh", "check.sh", CANARY],
					commit: r.revision.commit,
					branch: "refs/heads/main",
					execution: { kind: "exited", code: 0 },
					outcome: "passed",
					reasons: [],
					limitations: r.limitations,
					relation: "at-head",
				},
			],
		});
		expect(readAttempts(JSON.parse(JSON.stringify(view)))).toEqual(view);
		const text = JSON.stringify(view);
		expect(text).not.toContain(w.project);
		expect(text).not.toContain(w.root);
		expect(text).not.toContain("/.git");
		// Compared with ANOTHER launch directory (a different repository): not compared, never "stale".
		const elsewhere = await routes(w, w.otherRepo).route(["workspace", "attempts"], "GET", "", null);
		const shown = (elsewhere.body as EndoDevelopAttemptsViewV1).attempts.find((a) => a.id === w.attemptId);
		expect(shown?.receipts.list.map((x) => x.relation)).toEqual(["other-repository"]);
		commit(w.project, "z.txt", "z");
		const after_ = await routes(w, w.project).route(["workspace", "attempts"], "GET", "", null);
		expect(
			(after_.body as EndoDevelopAttemptsViewV1).attempts.find((a) => a.id === w.attemptId)?.receipts.list[0]
				?.relation,
		).toBe("head-differs");
	});

	it("has no route that runs a check or writes a receipt, and the request chooses nothing", async () => {
		const w = seeded();
		const tasks = routes(w, w.project);
		const before = readdirSync(join(w.root, "develop"));
		for (const path of ["attempts/check", "attempts/receipts", "receipts", "check", "attempts"])
			for (const method of ["POST", "GET"] as const) {
				if (method === "GET" && path === "attempts") continue;
				const reply = await tasks.route(["workspace", ...path.split("/")], method, "", {
					argv: ["sh", "-c", "touch x"],
				});
				expect([path, method, reply.status]).toEqual([path, method, 404]);
			}
		expect((await tasks.route(["workspace", "attempts"], "GET", `cwd=${w.otherRepo}`, null)).status).toBe(400);
		expect(readdirSync(join(w.root, "develop"))).toEqual(before);
		expect(existsSync(join(w.project, "x"))).toBe(false);
	});

	it("the gate refuses a receipt whose outcome its execution and reasons do not imply, or that carries a path", async () => {
		const w = seeded();
		await check(w, ["sh", "fail.sh"]);
		const reply = await routes(w, w.project).route(["workspace", "attempts"], "GET", "", null);
		const good = JSON.parse(JSON.stringify(reply.body));
		expect(readAttempts(good)).not.toBeNull();
		const at = good.attempts.findIndex((a: { id: string }) => a.id === w.attemptId);
		const bad = (mutate: (r: Record<string, unknown>) => void) => {
			const copy = JSON.parse(JSON.stringify(good));
			mutate(copy.attempts[at].receipts.list[0]);
			return readAttempts(copy);
		};
		expect(
			bad((r) => {
				r.outcome = "passed";
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.reasons = ["timed-out"];
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.execution = { kind: "timed-out" };
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.worktree = "/home/x";
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.relation = "verified";
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.argv = [`a${String.fromCharCode(0x202e)}b`];
			}),
		).toBeNull();
	});

	it("shows a branch name Git accepts but the page would refuse (a bidirectional control) safely, and keeps it exactly in the file", async () => {
		const w = seeded();
		const odd = `odd${String.fromCharCode(0x202e)}name`;
		git(w.project, "checkout", "-q", "-b", odd);
		const r = await check(w, ["sh", "check.sh"]);
		expect(r.revision.branch).toBe(`refs/heads/${odd}`);
		const reply = await routes(w, w.project).route(["workspace", "attempts"], "GET", "", null);
		const view = readAttempts(JSON.parse(JSON.stringify(reply.body)));
		expect(view?.attempts.find((a) => a.id === w.attemptId)?.receipts.list[0]?.branch).toBe(
			"refs/heads/odd\ufffdname",
		);
	});

	it("shows an operator's odd argument safely rather than refusing the whole view", async () => {
		const w = seeded();
		await check(w, ["sh", "check.sh", `x${String.fromCharCode(0x202e)}y\nz`]);
		const reply = await routes(w, w.project).route(["workspace", "attempts"], "GET", "", null);
		const view = readAttempts(JSON.parse(JSON.stringify(reply.body)));
		expect(view?.attempts.find((a) => a.id === w.attemptId)?.receipts.list[0]?.argv).toEqual([
			"sh",
			"check.sh",
			"x\ufffdy\ufffdz",
		]);
	});
});

// ---- the CLI, end to end ------------------------------------------------------------------------------------------------------------

describe.skipIf(!haveGit)("endo attempt check|receipts|receipt", () => {
	const endo = (args: string[], cwd = base) =>
		spawnSync(process.execPath, [CLI, "attempt", ...args], {
			cwd,
			encoding: "utf8",
			env: { ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, ".config") },
			timeout: 60_000,
		});

	it("records and exits by outcome (0 passed, 3 failed, 4 inconclusive, 2 refused), and never touches the task or attempt files", () => {
		const w = seeded();
		const before = recordsOf(w.root);
		const passed = endo(["check", "--root", w.root, "--attempt", w.attemptId, "--", "sh", "check.sh"]);
		expect([passed.status, JSON.parse(passed.stdout).receipt.label]).toEqual([0, "Observed check passed"]);
		expect(passed.stderr).toContain("an agent may have written");
		expect(passed.stderr).toContain("not acceptance of the task");
		const failed = endo(["check", "--root", w.root, "--attempt", w.attemptId, "--", "sh", "fail.sh"]);
		expect([failed.status, JSON.parse(failed.stdout).receipt.outcome]).toEqual([3, "failed"]);
		expect(failed.stderr).toContain("failing");
		const moved = endo(["check", "--root", w.root, "--attempt", w.attemptId, "--", "sh", "-c", "echo z > z.txt"]);
		expect([moved.status, JSON.parse(moved.stdout).receipt.reasons]).toEqual([
			4,
			["the working tree had changes afterwards"],
		]);
		const refused = endo(["check", "--root", w.root, "--attempt", w.attemptId, "--", "sh", "check.sh"]);
		expect([refused.status, refused.stdout]).toEqual([2, ""]);
		expect(refused.stderr).toContain("Nothing was run and nothing was recorded");
		rmSync(join(w.project, "z.txt"));
		const listed = endo(["receipts", "--root", w.root, "--attempt", w.attemptId]);
		expect(listed.status).toBe(0);
		const body = JSON.parse(listed.stdout);
		expect(body.receipts.map((r: { outcome: string; relation: string }) => [r.outcome, r.relation])).toEqual([
			["passed", "at-head"],
			["failed", "at-head"],
			["inconclusive", "at-head"],
		]);
		const one = endo(["receipt", "--root", w.root, "--receipt", body.receipts[1].id]);
		expect(JSON.parse(one.stdout).receipt).toMatchObject({ outcome: "failed", label: "Observed check failed" });
		expect(JSON.parse(one.stdout).receipt.limitations).toContain(
			ENDO_RECEIPT_LIMITATION_TEXT_V0["command-defines-the-check"],
		);
		expect(recordsOf(w.root)).toEqual(before);
	});

	it("runs only what follows --: never a command from the attempt, its brief or a receipt, and no agent", () => {
		const w = seeded();
		for (const args of [
			["check", "--root", w.root, "--attempt", w.attemptId],
			["check", "--root", w.root, "--attempt", w.attemptId, "--"],
			["check", "--root", w.root, "--attempt", w.attemptId, "sh", "check.sh"],
		]) {
			const r = endo(args);
			expect(r.status, args.join(" ")).toBe(1);
		}
		expect(existsSync(join(w.root, "develop", "receipts"))).toBe(false);
		// A real check whose own arguments mention agents runs exactly that, and starts no agent.
		const r = endo([
			"check",
			"--root",
			w.root,
			"--attempt",
			w.attemptId,
			"--",
			"sh",
			"-c",
			"echo pi omp claude codex",
		]);
		expect(r.status).toBe(0);
		expect(existsSync(AGENT_MARK)).toBe(false);
	});

	it("SIGINT stops the check, records it as interrupted, and exits 130", async () => {
		const w = seeded();
		const child = spawn(
			process.execPath,
			[CLI, "attempt", "check", "--root", w.root, "--attempt", w.attemptId, "--timeout", "60", "--", "sleep", "30"],
			{ env: { ...process.env, HOME }, stdio: ["ignore", "pipe", "pipe"] },
		);
		let err = "";
		let out = "";
		child.stderr.on("data", (c: Buffer) => {
			err += c.toString();
		});
		child.stdout.on("data", (c: Buffer) => {
			out += c.toString();
		});
		while (!err.includes("the check's own output follows")) await new Promise((r) => setTimeout(r, 25));
		await new Promise((r) => setTimeout(r, 200));
		child.kill("SIGINT");
		const code = await new Promise<number | null>((r) => child.on("close", (c) => r(c)));
		expect(code).toBe(130);
		expect(JSON.parse(out).receipt).toMatchObject({ outcome: "inconclusive", execution: { kind: "interrupted" } });
	}, 30_000);

	it("an unknown attempt, a malformed id and an unreadable receipt directory are refused, and a bad receipt file is listed by name", () => {
		const w = seeded();
		expect(endo(["receipts", "--root", w.root, "--attempt", `endo.attempt.${"e".repeat(32)}`]).status).toBe(1);
		expect(endo(["receipts", "--root", w.root, "--attempt", "x"]).status).toBe(1);
		expect(endo(["receipt", "--root", w.root, "--receipt", `endo.receipt.${"e".repeat(32)}`]).status).toBe(1);
		const dir = join(w.root, "develop", "receipts", w.attemptId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `endo.receipt.${"1".repeat(32)}.json`), "{");
		const listed = endo(["receipts", "--root", w.root, "--attempt", w.attemptId]);
		expect(JSON.parse(listed.stdout).problems).toEqual([
			{ name: `endo.receipt.${"1".repeat(32)}.json`, reason: "malformed" },
		]);
		chmodSync(dir, 0o000);
		try {
			if (process.getuid?.() !== 0)
				expect(endo(["receipts", "--root", w.root, "--attempt", w.attemptId]).status).toBe(1);
		} finally {
			chmodSync(dir, 0o700);
		}
	});
});
