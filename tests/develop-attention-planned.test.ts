// DEVELOP-ATTENTION-002: the attention overview reads a planned check by its attempt's own acceptance ledger, never by exit status
// (research/develop-validation/DEVELOP-VALIDATION-001.md, finding U1). Each case here was wrong before this change: the overview read the
// receipt's exit status, so an exit 0 with the wrong output needed no attention, a declared exit 2 was a failure, and disagreeing results at
// HEAD were hidden behind the latest one. Also B1 (what `endo attempt check` and `receipts` say) and F1 (the environment is not established).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type EndoDevelopAttentionPlannedV1, endoPlannedTriageV1 } from "../protocol/develop-attention.ts";
import type { EndoDevelopReceiptV0, EndoReceiptCurrentV0, EndoReceiptFactsV0 } from "../protocol/develop-receipts.ts";
import { ENDO_PLANNED_CHECK_STATES_V0, type EndoVerificationPlanV0 } from "../protocol/develop-verification.ts";
import { ENDO_ATTEMPT_EVIDENCE_NOT_ESTABLISHED_V0 } from "../runtime/contracts/develop-attempt-evidence.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { endoDevelopAttentionViewV0 } from "../runtime/contracts/develop-attention.ts";
import { endoAcceptanceLedgerV0 } from "../runtime/contracts/develop-verification.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { type Item, lineText, type Overview, overviewOf, plannedTriage } from "../studio-ui/src/model/attention.ts";
import { readAttention } from "../studio-ui/src/model/attention-wire.ts";
import type { Task } from "../studio-ui/src/model/workspace-wire.ts";
import { removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { git, haveGit } from "./git-fixtures.ts";
import { receiptAt, taskIn } from "./studio-attention-fixtures.ts";

afterEach(() => removeTempRoots((r) => rmSync(r, { recursive: true, force: true })));

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const CURRENT: EndoReceiptCurrentV0 = {
	worktree: "/work/calc",
	commonDir: "/work/calc/.git",
	commit: HEAD,
	clean: true,
};
const LAUNCH = "0123456789abcdef";
const T0 = Date.UTC(2026, 10, 10, 13, 0);
const at = (minutes: number) => T0 + minutes * 60_000;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const PRECEDENCE = ["node", "calc.mjs", "2+3*4"];
const REFUSES = ["node", "calc.mjs", "x"];
const TESTS = ["npm", "test"];
const PLAN: EndoVerificationPlanV0 = {
	checks: [
		{ name: "precedence", argv: PRECEDENCE, shows: "2+3*4 is 14", expect: { exitCode: 0, stdout: "14\n" } },
		{ name: "refuses", argv: REFUSES, shows: "bad input is refused", expect: { exitCode: 2, stdout: "" } },
		{ name: "tests", argv: TESTS, shows: "the suite passes" },
	],
	criteria: [
		{ text: "2+3*4 is 14", checks: ["precedence"] },
		{ text: "Bad input is refused", checks: ["refuses"] },
		{ text: "The suite passes", checks: ["tests"] },
		{ text: "It is readable", checks: [] },
	],
};

function project() {
	const root = tempRoot("endo-attention-planned-");
	const tasks = new DevelopTasksStoreV0(root);
	const made = tasks.registerProject({ name: "Calc", path: "/work/calc", observedGitRoot: "/work/calc" });
	if (!made.ok) throw new Error(made.code);
	const attempts = new DevelopAttemptsStoreV0(root);
	const receipts = new DevelopReceiptsStoreV0(root);
	let clock = T0;
	const service = new DevelopAttemptsServiceV0(tasks, attempts, {
		now: () => {
			clock += 1000;
			return clock;
		},
	});
	const projectId = made.value.id;
	/** An attempt with `verification` as its plan; null prepares one without a plan (a v0 attempt). */
	const attempt = (taskId: string, verification: EndoVerificationPlanV0 | null = PLAN) => {
		const got = service.prepare(projectId, taskId, {
			objective: "Fix it.",
			...(verification === null ? {} : { verification }),
		});
		if (!got.ok) throw new Error(got.code);
		return got.value.id;
	};
	/** A v1 receipt of `argv` that exited `code` and printed `stdout`, at `minutes` (and `change`, e.g. another commit). */
	const ran = (
		attemptId: string,
		minutes: number,
		argv: string[],
		code: number,
		stdout: string,
		change: Partial<EndoReceiptFactsV0> = {},
	) => {
		const base = receiptAt(CURRENT, attemptId, projectId, at(minutes), {
			check: { argv, executable: "/usr/bin/node", realExecutable: "/usr/bin/node", timeoutMs: 600_000 },
			execution: { kind: "exited", code },
			...change,
		});
		const receipt: EndoDevelopReceiptV0 = {
			...base,
			schemaVersion: "endo.develop-receipt.v1",
			output: {
				stdoutBytes: Buffer.byteLength(stdout),
				stderrBytes: 0,
				stdout: { sha256: sha(stdout), keep: "off" },
			},
		};
		const written = receipts.write(receipt);
		if (written !== "created") throw new Error(written);
		return receipt;
	};
	const view = (current: EndoReceiptCurrentV0 | null = CURRENT) =>
		endoDevelopAttentionViewV0({ tasks, attempts, receipts }, { projectId, launchId: LAUNCH }, current);
	const workspaceTasks = (): Task[] =>
		new DevelopWorkspaceServiceV0(tasks)
			.forLaunch(
				{ projectId, launchDirectory: "/nonexistent" },
				{ launchId: LAUNCH, attachment: "pi.default", session: null },
			)
			.view().tasks as Task[];
	/** The page's overview of this store, through the browser's own wire gate: a body the gate refuses fails the test. */
	const overview = (current: EndoReceiptCurrentV0 | null = CURRENT): Overview => {
		const v = view(current);
		const gated = readAttention(JSON.parse(JSON.stringify(v)));
		if (gated === null) throw new Error(`the page's gate refused the view: ${JSON.stringify(v)}`);
		return overviewOf(workspaceTasks(), "shown", gated, gated.taskRevision);
	};
	/** The ledger the Task view and `endo attempt evidence` show, over the same receipts. */
	const ledger = (attemptId: string, current: EndoReceiptCurrentV0 | null = CURRENT) => {
		const read = receipts.read(attemptId);
		if (!read.ok) throw new Error("unreadable");
		return endoAcceptanceLedgerV0({ plan: PLAN, receipts: read.receipts, current });
	};
	return { root, projectId, attempt, ran, view, overview, ledger };
}

const itemOf = (o: Overview, taskId: string): Item =>
	[...o.attention, ...o.waiting, ...o.open, ...o.done].find((i) => i.task.id === taskId) as Item;
const texts = (i: Item) => i.lines.map(lineText);
const plannedOf = (p: ReturnType<typeof project>, taskId: string) =>
	p.view().tasks.find((t) => t.taskId === taskId)?.planned ?? [];
const stateOf = (p: ReturnType<typeof project>, taskId: string, name: string) =>
	plannedOf(p, taskId).find((c) => c.name === name)?.state;

describe("the overview reads a planned check as its attempt's ledger does", () => {
	it("U1a: an exit 0 with the wrong output is a failure that needs attention (it read as passed)", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Fix precedence", "in-progress");
		const a = p.attempt(task);
		p.ran(a, 1, PRECEDENCE, 0, "20\n");
		expect(p.ledger(a).checks.find((c) => c.name === "precedence")?.state).toBe("failed");
		expect(stateOf(p, task, "precedence")).toBe("failed");
		const o = p.overview();
		const item = itemOf(o, task);
		expect(item.section).toBe("attention");
		expect(item.flags).toEqual(["failed"]);
		expect(texts(item)).toContain(
			"Planned check `precedence`: Failed at HEAD (read by its declared exit code and output).",
		);
		// The row opens the receipt behind it.
		expect(item.focus?.attemptId).toBe(a);
		// Nothing about it reads as an observed exit-status failure or a pass.
		expect(texts(item).join("\n")).not.toMatch(/exited with code|passed at the current HEAD/);
	});

	it("U1b: a declared exit 2 with the declared output passes, and raises no alarm (it read as a failed check)", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Refuse bad input", "in-progress");
		const a = p.attempt(task);
		p.ran(a, 1, REFUSES, 2, "");
		expect(stateOf(p, task, "refuses")).toBe("passed");
		const item = itemOf(p.overview(), task);
		expect(item.section).toBe("waiting");
		expect(item.flags).toEqual([]);
		expect(texts(item).join("\n")).not.toMatch(/Check failed|exited with code 2/);
	});

	it("U1c: a pass and a failure at the same HEAD disagree, and stay visible (the latest one hid the other)", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Flaky", "in-progress");
		const a = p.attempt(task);
		p.ran(a, 1, PRECEDENCE, 0, "20\n");
		p.ran(a, 2, PRECEDENCE, 0, "14\n");
		expect(p.ledger(a).checks.find((c) => c.name === "precedence")?.state).toBe("mixed");
		expect(stateOf(p, task, "precedence")).toBe("mixed");
		const item = itemOf(p.overview(), task);
		expect(item.flags).toEqual(["inconclusive"]);
		expect(texts(item)).toContain(
			"Planned check `precedence`: Results at HEAD disagree (1 passed, 1 failed) (read by its declared exit code and output).",
		);
		// A plain (exit-status) planned check too: one pass and one failure of npm test at HEAD.
		p.ran(a, 3, TESTS, 0, "ok\n");
		p.ran(a, 4, TESTS, 1, "not ok\n");
		expect(stateOf(p, task, "tests")).toBe("mixed");
	});

	it("a pass at an older commit is not a current pass; a review is asked to recheck it", () => {
		const p = project();
		const going = taskIn(p.root, p.projectId, "Older pass, in progress", "in-progress");
		const review = taskIn(p.root, p.projectId, "Older pass, in review", "review");
		const elsewhere = {
			revision: { commit: OLD, tree: "e".repeat(40), branch: "refs/heads/main" },
			after: {
				state: "observed" as const,
				sameRepository: true,
				commit: OLD,
				tree: "e".repeat(40),
				clean: true,
				reflogsUnchanged: true,
				rulesUnchanged: true,
			},
		};
		for (const t of [going, review]) p.ran(p.attempt(t), 1, PRECEDENCE, 0, "14\n", elsewhere);
		expect(stateOf(p, going, "precedence")).toBe("stale");
		const o = p.overview();
		const g = itemOf(o, going);
		expect(g.flags).toEqual([]);
		expect(texts(g)).toContain(
			`Planned check \`precedence\`: Not run at HEAD (only at other commits) (its latest run, at ${OLD.slice(0, 7)}, passed) (read by its declared exit code and output).`,
		);
		expect(itemOf(o, review).flags).toEqual(["decision", "reconsider"]);
		expect(o.unsettled).toBe(true);
	});

	it("a pass followed by a change to the working tree is not a current pass", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Dirty after pass", "review");
		p.ran(p.attempt(task), 1, PRECEDENCE, 0, "14\n");
		const dirty = { ...CURRENT, clean: false };
		const states = p
			.view(dirty)
			.tasks.find((t) => t.taskId === task)
			?.planned.map((c) => [c.name, c.state]);
		expect(states).toContainEqual(["precedence", "tree-changed"]);
		const item = itemOf(p.overview(dirty), task);
		expect(item.flags).toEqual(["decision", "reconsider"]);
		expect(texts(item)).toContain(
			"Planned check `precedence`: At HEAD, but the tree has changed since (its latest run at HEAD passed) (read by its declared exit code and output).",
		);
	});

	it("a failure is not dropped because the tree moved on, or because it was recorded at an older commit", () => {
		const p = project();
		const dirtyAfterFail = taskIn(p.root, p.projectId, "Failed, then edited", "in-progress");
		const olderFail = taskIn(p.root, p.projectId, "Failed at an older commit", "in-progress");
		p.ran(p.attempt(dirtyAfterFail), 1, PRECEDENCE, 0, "20\n");
		const before = {
			revision: { commit: OLD, tree: "e".repeat(40), branch: "refs/heads/main" },
			after: {
				state: "observed" as const,
				sameRepository: true,
				commit: OLD,
				tree: "e".repeat(40),
				clean: true,
				reflogsUnchanged: true,
				rulesUnchanged: true,
			},
		};
		p.ran(p.attempt(olderFail), 1, PRECEDENCE, 0, "20\n", before);
		const dirty = { ...CURRENT, clean: false };
		const o = p.overview(dirty);
		const edited = itemOf(o, dirtyAfterFail);
		expect(edited.flags).toEqual(["failed"]);
		expect(texts(edited)).toContain(
			"Planned check `precedence`: At HEAD, but the tree has changed since (its latest run at HEAD failed) (read by its declared exit code and output).",
		);
		const older = itemOf(p.overview(), olderFail);
		expect(older.flags).toEqual(["failed"]);
		expect(texts(older)).toContain(
			`Planned check \`precedence\`: Not run at HEAD (only at other commits) (its latest run, at ${OLD.slice(0, 7)}, failed) (read by its declared exit code and output).`,
		);
		// Runs at HEAD that disagree, then an edit: still not settled.
		const flaky = taskIn(p.root, p.projectId, "Disagreed, then edited", "in-progress");
		const f = p.attempt(flaky);
		p.ran(f, 2, PRECEDENCE, 0, "14\n");
		p.ran(f, 3, PRECEDENCE, 0, "20\n");
		p.ran(f, 4, PRECEDENCE, 0, "14\n");
		expect(itemOf(p.overview(dirty), flaky).flags).toEqual(["inconclusive"]);
	});

	it("a planned check never run is said, never read as passed, and the overview says there is no current result", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Nothing run", "in-progress");
		p.attempt(task);
		expect(plannedOf(p, task).map((c) => c.state)).toEqual(["not-run", "not-run", "not-run"]);
		const o = p.overview();
		const item = itemOf(o, task);
		expect(item.flags).toEqual([]);
		expect(texts(item)).toContain("Planned check `precedence`: Not run (read by its declared exit code and output).");
		expect(o.unsettled).toBe(true);
	});

	it("a receipt that cannot be read is said, and never turns into a pass or into 'not run'", () => {
		const p = project();
		const damaged = taskIn(p.root, p.projectId, "A damaged receipt", "in-progress");
		const a = p.attempt(damaged);
		p.ran(a, 1, PRECEDENCE, 0, "14\n");
		writeFileSync(join(p.root, "develop", "receipts", a, `endo.receipt.${"f".repeat(32)}.json`), "{not json");
		const unreadable = taskIn(p.root, p.projectId, "An unreadable directory", "in-progress");
		const b = p.attempt(unreadable);
		mkdirSync(join(p.root, "develop", "receipts"), { recursive: true });
		writeFileSync(join(p.root, "develop", "receipts", b), "not a directory");
		const o = p.overview();
		expect(o.gaps).toBe(true);
		expect(texts(itemOf(o, damaged))).toContain("One file among its checks could not be used.");
		// The attempt whose receipts could not be read contributes no planned entries: nothing about them is known.
		expect(plannedOf(p, unreadable)).toEqual([]);
		expect(texts(itemOf(o, unreadable))).toContain(
			"One attempt's checks could not be read; what is shown may be incomplete.",
		);
	});

	it("an attempt without a plan keeps v0's exit-status reading", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "No plan", "in-progress");
		const a = p.attempt(task, null);
		p.ran(a, 1, PRECEDENCE, 0, "20\n");
		p.ran(a, 2, REFUSES, 2, "");
		const v = p.view().tasks.find((t) => t.taskId === task);
		expect(v?.planned).toEqual([]);
		expect(v?.checks.map((c) => [c.command, c.outcome])).toEqual([
			["node calc.mjs x", "failed"],
			["node calc.mjs 2+3*4", "passed"],
		]);
		expect(itemOf(p.overview(), task).flags).toEqual(["failed"]);
	});

	it("two attempts that run the same argv are each read by their own plan, never by the other's", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Two attempts", "in-progress");
		const planned = p.attempt(task);
		const plain = p.attempt(task, null);
		// The same command, exit 2 and no output, recorded once under each attempt.
		p.ran(planned, 1, REFUSES, 2, "");
		p.ran(plain, 2, REFUSES, 2, "");
		const v = p.view().tasks.find((t) => t.taskId === task);
		// The planned attempt's ledger: passed, counting only its own receipt.
		const refuses = v?.planned.find((c) => c.name === "refuses");
		expect(refuses).toMatchObject({
			attemptId: planned,
			state: "passed",
			atHead: { passed: 1, failed: 0, inconclusive: 0 },
		});
		// The other attempt has no plan: its receipt is read by exit status, as before, and is not counted by the first attempt's plan.
		expect(v?.checks.map((c) => [c.attemptId, c.outcome])).toEqual([[plain, "failed"]]);
		// The row says the failing line is not a plan's reading.
		expect(texts(itemOf(p.overview(), task))).toContain(
			"Latest observed `node calc.mjs x` exited with code 2 at the current HEAD. No plan reads this check; this is its exit status.",
		);
		// A second plan that expects something else reads the same command its own way.
		const other: EndoVerificationPlanV0 = {
			checks: [{ name: "refuses", argv: REFUSES, shows: "x", expect: { exitCode: 1, stdout: "" } }],
			criteria: [{ text: "x", checks: ["refuses"] }],
		};
		const third = p.attempt(task, other);
		p.ran(third, 3, REFUSES, 2, "");
		const both = p
			.view()
			.tasks.find((t) => t.taskId === task)
			?.planned.filter((c) => c.name === "refuses");
		// The newest attempt's plan reads its own run its own way (exit 1 expected, exit 2 observed: failed). It ran this command, so the older
		// attempt's reading of it is superseded, as v0's "the latest run of a command decides" rule did; it never borrows the other's verdict.
		expect(both?.map((c) => [c.attemptId, c.state])).toEqual([[third, "failed"]]);
	});

	it("F1: a passing comparison does not establish the environment, and the evidence says so", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Passing under any environment", "in-progress");
		// The output an environment hook could produce from the wrong program: the receipt cannot tell.
		p.ran(p.attempt(task), 1, PRECEDENCE, 0, "14\n");
		expect(stateOf(p, task, "precedence")).toBe("passed");
		const limit = ENDO_ATTEMPT_EVIDENCE_NOT_ESTABLISHED_V0.find((l) => l.includes("environment"));
		expect(limit).toMatch(/NODE_OPTIONS/);
		expect(limit).toMatch(/inherited and not recorded/);
		expect(limit).toMatch(/requestedBy names who the record says asked for the check, not who ran it/);
	});
});

// The adversarial review of DEVELOP-ATTENTION-002 (research/develop-validation/DEVELOP-VALIDATION-002.md): each case below dropped a
// recorded planned failure out of attention in the first cut, where v0 had flagged it, or contradicted the newest attempt's Task view.
describe("a recorded planned failure is never dropped from attention", () => {
	const OTHER_TREE = { worktree: "/work/calc-agent", commonDir: "/work/calc/.git", linked: true };
	it("R2: a failure recorded in another working tree still needs attention, and says where", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Agent worktree", "in-progress");
		p.ran(p.attempt(task), 1, PRECEDENCE, 0, "20\n", { repository: OTHER_TREE });
		expect(stateOf(p, task, "precedence")).toBe("elsewhere");
		const item = itemOf(p.overview(), task);
		expect(item.flags).toEqual(["failed"]);
		expect(texts(item)).toContain(
			"Planned check `precedence`: Run only in another working tree (its latest run there failed) (read by its declared exit code and output).",
		);
	});

	it("R1: with HEAD unreadable, a recorded failure still needs attention", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "No HEAD", "in-progress");
		p.ran(p.attempt(task), 1, PRECEDENCE, 0, "20\n");
		const item = itemOf(p.overview(null), task);
		expect(item.flags).toEqual(["failed"]);
		expect(texts(item)).toContain(
			"Planned check `precedence`: Not compared (its latest run failed; this worktree's HEAD could not be read) (read by its declared exit code and output).",
		);
	});

	it("R3: the per-task limit never cuts a failure while listing passes", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Many checks", "in-progress");
		const older = {
			revision: { commit: OLD, tree: "e".repeat(40), branch: "refs/heads/main" },
			after: {
				state: "observed" as const,
				sameRepository: true,
				commit: OLD,
				tree: "e".repeat(40),
				clean: true,
				reflogsUnchanged: true,
				rulesUnchanged: true,
			},
		};
		const wide: EndoVerificationPlanV0 = {
			checks: Array.from({ length: 8 }, (_, i) => ({
				name: `c${i}`,
				argv: ["node", "calc.mjs", `${i}+${i}`],
				shows: "x",
			})),
			criteria: [{ text: "all", checks: Array.from({ length: 8 }, (_, i) => `c${i}`) }],
		};
		const a1 = p.attempt(task);
		p.ran(a1, 1, PRECEDENCE, 0, "20\n", older);
		const a2 = p.attempt(task, wide);
		for (let i = 0; i < 8; i++) p.ran(a2, 2 + i, ["node", "calc.mjs", `${i}+${i}`], 0, "ok\n", older);
		const v = p.view().tasks.find((t) => t.taskId === task);
		expect(v?.planned[0]).toMatchObject({ attemptId: a1, name: "precedence", state: "stale" });
		expect(itemOf(p.overview(), task).flags).toEqual(["failed"]);
	});

	it("R4: an older attempt lists only checks it ran, a newer attempt's run supersedes it, and lines name their attempt", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Superseded", "in-progress");
		const older = {
			revision: { commit: OLD, tree: "e".repeat(40), branch: "refs/heads/main" },
			after: {
				state: "observed" as const,
				sameRepository: true,
				commit: OLD,
				tree: "e".repeat(40),
				clean: true,
				reflogsUnchanged: true,
				rulesUnchanged: true,
			},
		};
		const a1 = p.attempt(task);
		p.ran(a1, 1, PRECEDENCE, 0, "20\n", older);
		const a2 = p.attempt(task);
		p.ran(a2, 2, PRECEDENCE, 0, "14\n");
		p.ran(a2, 3, REFUSES, 2, "");
		p.ran(a2, 4, TESTS, 0, "ok\n");
		const v = p.view().tasks.find((t) => t.taskId === task);
		// The newer attempt ran precedence: the older failure of that command is superseded, as v0's "latest receipt" rule did.
		// Passes are listed most recent first.
		expect(v?.planned.map((c) => [c.attemptId === a2 ? "newest" : "older", c.name, c.state])).toEqual([
			["newest", "tests", "passed"],
			["newest", "refuses", "passed"],
			["newest", "precedence", "passed"],
		]);
		expect(itemOf(p.overview(), task).flags).toEqual([]);
		// An older attempt's failure of a command the newest has not run stays listed, named by its attempt; its unrun checks are not.
		const t2 = taskIn(p.root, p.projectId, "Older failure, newest not run", "in-progress");
		const b1 = p.attempt(t2);
		p.ran(b1, 5, PRECEDENCE, 0, "20\n", older);
		const b2 = p.attempt(t2);
		p.ran(b2, 6, REFUSES, 2, "");
		const w = p.view().tasks.find((t) => t.taskId === t2);
		expect(w?.planned.map((c) => [c.attemptId === b2 ? "newest" : "older", c.name, c.state])).toEqual([
			["older", "precedence", "stale"],
			["newest", "precedence", "not-run"],
			["newest", "tests", "not-run"],
			["newest", "refuses", "passed"],
		]);
		const lines = texts(itemOf(p.overview(), t2));
		expect(lines.some((l) => l.includes("`precedence`") && l.includes(`attempt ${b1.slice(13, 20)}`))).toBe(true);
	});

	it("R5: a pass beside receipt files that could not be read is not a current pass", () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Damaged beside a pass", "review");
		const a = p.attempt(task);
		p.ran(a, 1, REFUSES, 2, "");
		writeFileSync(join(p.root, "develop", "receipts", a, `endo.receipt.${"f".repeat(32)}.json`), "{not json");
		const refuses = plannedOf(p, task).find((c) => c.name === "refuses");
		expect(refuses).toMatchObject({ state: "passed", incomplete: true });
		const item = itemOf(p.overview(), task);
		expect(item.flags).toEqual(["decision", "reconsider"]);
		expect(texts(item)).toContain(
			"Planned check `refuses`: Passed at HEAD (some of this attempt's receipt files could not be read; a later result may be among them) (read by its declared exit code and output).",
		);
	});
});

// The re-verification of the review fixes: a newer attempt supersedes an older one's entry only with a LATER run that is at least as
// current (same tree, HEAD before other commits before other worktrees). Each case hid a later failure in the first superseding rule.
describe("a newer attempt never hides a later or more current failure", () => {
	const OTHER_TREE = { worktree: "/work/calc-agent", commonDir: "/work/calc/.git", linked: true };
	const atOld = {
		revision: { commit: OLD, tree: "e".repeat(40), branch: "refs/heads/main" },
		after: {
			state: "observed" as const,
			sameRepository: true,
			commit: OLD,
			tree: "e".repeat(40),
			clean: true,
			reflogsUnchanged: true,
			rulesUnchanged: true,
		},
	};
	const setup = (title: string) => {
		const p = project();
		const task = taskIn(p.root, p.projectId, title, "in-progress");
		const a1 = p.attempt(task);
		const a2 = p.attempt(task);
		return { p, task, a1, a2 };
	};
	it("C1: an older attempt's later failure at HEAD is not hidden by a newer attempt's earlier pass there", () => {
		const { p, task, a1, a2 } = setup("C1");
		p.ran(a2, 1, PRECEDENCE, 0, "14\n");
		p.ran(a1, 5, PRECEDENCE, 0, "20\n");
		expect(itemOf(p.overview(), task).flags).toEqual(["failed"]);
	});
	it("C2: a pass in another worktree does not hide a failure here", () => {
		const { p, task, a1, a2 } = setup("C2");
		p.ran(a1, 1, PRECEDENCE, 0, "20\n");
		p.ran(a2, 5, PRECEDENCE, 0, "14\n", { repository: OTHER_TREE });
		expect(itemOf(p.overview(), task).flags).toEqual(["failed"]);
	});
	it("C3: a stale pass does not hide a later failure at HEAD", () => {
		const { p, task, a1, a2 } = setup("C3");
		p.ran(a2, 1, PRECEDENCE, 0, "14\n", atOld);
		p.ran(a1, 5, PRECEDENCE, 0, "20\n");
		expect(itemOf(p.overview(), task).flags).toEqual(["failed"]);
	});
	it("C4: with HEAD unreadable, an earlier pass elsewhere does not hide a later failure", () => {
		const { p, task, a1, a2 } = setup("C4");
		p.ran(a2, 1, PRECEDENCE, 0, "14\n", { repository: OTHER_TREE });
		p.ran(a1, 5, PRECEDENCE, 0, "20\n");
		expect(itemOf(p.overview(null), task).flags).toEqual(["failed"]);
	});
	it("a newer attempt's later, current pass does supersede an older failure (v0's latest-run rule)", () => {
		const { p, task, a1, a2 } = setup("Supersede");
		p.ran(a1, 1, PRECEDENCE, 0, "20\n", atOld);
		p.ran(a2, 5, PRECEDENCE, 0, "14\n");
		expect(itemOf(p.overview(), task).flags).toEqual([]);
		// The same later pass, but in another worktree: the older failure here stays.
		const q = setup("Not superseded from elsewhere");
		q.p.ran(q.a1, 1, PRECEDENCE, 0, "20\n");
		q.p.ran(q.a2, 5, PRECEDENCE, 0, "14\n", { repository: OTHER_TREE });
		expect(itemOf(q.p.overview(), q.task).flags).toEqual(["failed"]);
	});
});

describe("one triage rule", () => {
	it("the page's mirror equals the protocol's over every state, reading, count and completeness", () => {
		let n = 0;
		for (const state of ENDO_PLANNED_CHECK_STATES_V0)
			for (const outcome of [null, "passed", "failed", "inconclusive"] as const)
				for (const atHead of [
					{ passed: 0, failed: 0, inconclusive: 0 },
					{ passed: 1, failed: 0, inconclusive: 0 },
					{ passed: 1, failed: 1, inconclusive: 0 },
					{ passed: 0, failed: 2, inconclusive: 1 },
				])
					for (const incomplete of [false, true]) {
						const p: EndoDevelopAttentionPlannedV1 = {
							attemptId: `endo.attempt.${"1".repeat(32)}`,
							name: "x",
							command: "x",
							behavioural: true,
							state,
							atHead,
							receipt:
								outcome === null
									? null
									: {
											receiptId: `endo.receipt.${"2".repeat(32)}`,
											commit: HEAD,
											startedAtMs: 1,
											endedAtMs: 2,
											outcome,
										},
							incomplete,
						};
						expect(plannedTriage(p), JSON.stringify(p)).toBe(endoPlannedTriageV1(p));
						n += 1;
					}
		expect(n).toBe(ENDO_PLANNED_CHECK_STATES_V0.length * 4 * 4 * 2);
	});
});

describe("the page's gate refuses a planned entry its facts do not allow", () => {
	const real = () => {
		const p = project();
		const task = taskIn(p.root, p.projectId, "Gate", "in-progress");
		const a = p.attempt(task);
		p.ran(a, 1, PRECEDENCE, 0, "14\n");
		p.ran(a, 2, REFUSES, 2, "");
		return JSON.parse(JSON.stringify(p.view())) as ReturnType<typeof p.view>;
	};
	it("accepts what the projection serves, and refuses each incoherent change", () => {
		expect(readAttention(real())).not.toBeNull();
		const mutate = (change: (v: ReturnType<typeof real>) => void) => {
			const v = real();
			change(v);
			return readAttention(v);
		};
		type Planned = ReturnType<typeof real>["tasks"][number]["planned"][number];
		// A pass at HEAD (the triage order lists the unrun check first, so pick by state).
		const passed = (v: ReturnType<typeof real>) => v.tasks[0]?.planned.find((c) => c.state === "passed") as Planned;
		const notRun = (v: ReturnType<typeof real>) => v.tasks[0]?.planned.find((c) => c.state === "not-run") as Planned;
		expect(
			mutate((v) => {
				passed(v).state = "failed";
			}),
		).toBeNull(); // a pass's receipt and counts, called failed
		expect(
			mutate((v) => {
				(passed(v).receipt as NonNullable<Planned["receipt"]>).commit = OLD;
			}),
		).toBeNull(); // at HEAD, receipt elsewhere
		expect(
			mutate((v) => {
				passed(v).state = "not-run";
			}),
		).toBeNull(); // not run, with a receipt
		expect(
			mutate((v) => {
				notRun(v).state = "passed";
			}),
		).toBeNull(); // passed, with no receipt
		expect(
			mutate((v) => {
				passed(v).atHead.failed = 1;
			}),
		).toBeNull(); // passed, with a failure at HEAD counted
		expect(
			mutate((v) => {
				v.head = { commit: HEAD, clean: false };
			}),
		).toBeNull(); // passed, though the tree is not clean
		expect(
			mutate((v) => {
				v.head = null;
			}),
		).toBeNull(); // compared, without a HEAD
		expect(mutate((v) => v.tasks[0]?.planned.push({ ...passed(v) }))).toBeNull(); // listed twice
		expect(
			mutate((v) => {
				v.schemaVersion = "endo.develop-attention-view.v0" as never;
			}),
		).toBeNull();
	});
});

describe.skipIf(!haveGit)("B1 and F1 at the terminal: what endo attempt check and receipts say", () => {
	const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
	const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-attention-002-")));
	afterAll(() => rmSync(base, { recursive: true, force: true }));
	const HOME = join(base, "home");
	mkdirSync(HOME);
	const endo = (cwd: string, args: string[], env: Record<string, string> = {}) =>
		spawnSync(process.execPath, [CLI, ...args], {
			cwd,
			encoding: "utf8",
			env: { ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, ".config"), ...env },
			timeout: 60_000,
		});

	it("a behavioural check's run is compared with the plan, labelled as derived; the exit code stays the exit status's", () => {
		const root = join(base, "store");
		const repo = join(base, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		// Left to right: 2+3*4 prints 20. A non-number exits 2 with nothing on stdout.
		writeFileSync(
			join(repo, "calc.mjs"),
			'const t = process.argv[2];\nif (!/^[0-9+*]+$/.test(t)) process.exit(2);\nconst s = t.match(/\\d+|[+*]/g);\nlet v = Number(s[0]);\nfor (let i = 1; i < s.length; i += 2) v = s[i] === "+" ? v + Number(s[i + 1]) : v * Number(s[i + 1]);\nconsole.log(v);\n',
		);
		git(repo, "add", ".");
		git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "calc");
		const planFile = join(base, "plan.json");
		writeFileSync(planFile, JSON.stringify(PLAN));
		const id = (out: string, kind: string) => out.match(new RegExp(`endo\\.${kind}\\.[0-9a-f]{32}`))?.[0] as string;
		const P = id(endo(repo, ["project", "add", "--root", root, "--name", "Calc", "--path", repo]).stdout, "project");
		const T = id(
			endo(repo, ["task", "add", "--root", root, "--project", P, "--title", "Fix precedence"]).stdout,
			"task",
		);
		const A = id(
			endo(repo, [
				"attempt",
				"prepare",
				"--root",
				root,
				"--project",
				P,
				"--task",
				T,
				"--objective",
				"Fix it",
				"--plan-file",
				planFile,
			]).stdout,
			"attempt",
		);

		const wrong = endo(repo, ["attempt", "check", "--root", root, "--attempt", A, "--", ...PRECEDENCE]);
		expect(wrong.status).toBe(0); // the exit-code contract: the exit status, unchanged
		expect(wrong.stderr).toContain("recorded: Observed check passed");
		expect(wrong.stderr).toContain(
			'plan: this is planned check "precedence", which your plan reads by its declared exit code and output, not by its exit status. Compared with that declaration, this run does NOT match it',
		);
		expect(JSON.parse(wrong.stdout).outcomeIs).toMatch(/exit status/);

		const refusal = endo(repo, ["attempt", "check", "--root", root, "--attempt", A, "--", ...REFUSES]);
		expect(refusal.status).toBe(3);
		expect(refusal.stderr).toContain("this run matches it");

		// A plain planned check (exit status) gets no such line: its plan reads it as the receipt does.
		const listed = JSON.parse(endo(repo, ["attempt", "receipts", "--root", root, "--attempt", A]).stdout);
		expect(listed.outcomeIs).toMatch(/never compare its output/);
		const byArgv = (argv: string[]) =>
			listed.receipts.find((r: { argv: string[] }) => r.argv.join(" ") === argv.join(" "));
		expect(byArgv(PRECEDENCE)).toMatchObject({
			outcome: "passed",
			planned: { check: "precedence", readBy: "declared exit code and output", outcome: "failed" },
		});
		expect(byArgv(REFUSES)).toMatchObject({ outcome: "failed", planned: { check: "refuses", outcome: "passed" } });

		// The evidence reading names the environment as not established.
		const evidence = endo(repo, ["attempt", "evidence", "--root", root, "--attempt", A]);
		expect(evidence.stderr).toContain("The environment it ran in (variables such as NODE_OPTIONS or PATH");

		// The same store through the attention projection: the exit-0 failure needs attention; the refusal does not.
		const view = endoDevelopAttentionViewV0(
			{
				tasks: new DevelopTasksStoreV0(root),
				attempts: new DevelopAttemptsStoreV0(root),
				receipts: new DevelopReceiptsStoreV0(root),
			},
			{ projectId: P, launchId: LAUNCH },
			{ worktree: repo, commonDir: join(repo, ".git"), commit: git(repo, "rev-parse", "HEAD").trim(), clean: true },
		);
		const states = view.tasks[0]?.planned.map((c) => [c.name, c.state]);
		expect(states).toContainEqual(["precedence", "failed"]);
		expect(states).toContainEqual(["refuses", "passed"]);
		expect(states).toContainEqual(["tests", "not-run"]);
	});
});
