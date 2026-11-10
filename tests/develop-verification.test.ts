// DEVELOP-VERIFY-001 (docs/designs/develop-verification-plans.md): verification plans and the acceptance ledger.
//
// - the plan's invariants, and the v0/v1 boundary of the prepared record (a v0 record, its brief and its digest are unchanged);
// - the ledger, state by state, with exact-argv identity, other trees, stale and changed trees, disagreeing runs and unplanned receipts;
// - the criterion rule, and the page's mirror of it and of the labels (a contract test);
// - the page's gate: a real view is accepted, and each forged claim is refused with the whole body;
// - end to end, in a real Git repository through the real CLI: prepare with --plan-file, checks run with --, the evidence reading and the
//   workbench's view. The task file and the attempt records are never written by any of it.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { GitRevisionObserverV0 } from "../adapters/git/revision-observer.ts";
import {
	ENDO_DEVELOP_ATTEMPT_LIMITS_V0,
	type EndoDevelopAttemptV0,
	type EndoDevelopAttemptViewV5,
	renderEndoDevelopBriefV0,
	validateEndoDevelopAttemptV0,
} from "../protocol/develop-attempts.ts";
import {
	type EndoDevelopReceiptV0,
	type EndoReceiptCurrentV0,
	endoReceiptRelationV0,
	endoReceiptVerdictV0,
} from "../protocol/develop-receipts.ts";
import {
	ENDO_CRITERION_LABELS_V0,
	ENDO_CRITERION_STATES_V0,
	ENDO_CRITERION_TEXT_V0,
	ENDO_PLANNED_CHECK_LABELS_V0,
	ENDO_PLANNED_CHECK_STATES_V0,
	type EndoPlannedCheckStateV0,
	type EndoVerificationPlanV0,
	endoCriterionStateV0,
	validateEndoVerificationPlanV0,
} from "../protocol/develop-verification.ts";
import { sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { endoAttemptEvidenceV0 } from "../runtime/contracts/develop-attempt-evidence.ts";
import { DevelopAttemptsServiceV0, endoAttemptVerificationViewV0 } from "../runtime/contracts/develop-attempts.ts";
import { endoAcceptanceLedgerV0 } from "../runtime/contracts/develop-verification.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import {
	CRITERION_LABELS,
	CRITERION_TEXT,
	criterionState,
	PLANNED_CHECK_LABELS,
	readAttempts,
	verificationCoherent,
} from "../studio-ui/src/model/attempts-wire.ts";
import { git, haveGit } from "./git-fixtures.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-verify-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const dir = join(base, `${name}-${made}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
/** The attempt records in a store: none when the directory was never made. */
const recordFiles = (root: string): string[] => {
	const dir = join(root, "develop", "attempts");
	return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(r.code);
	return r.value;
};

const PLAN: EndoVerificationPlanV0 = {
	checks: [
		{ name: "unit", argv: ["node", "--test"], shows: "the unit tests pass" },
		{ name: "lint", argv: ["npm", "run", "lint"], shows: "the linter reports nothing" },
	],
	criteria: [
		{ text: "node --test exits 0 at a clean commit", checks: ["unit"] },
		{ text: "Code is lint-clean and tested", checks: ["unit", "lint"] },
		{ text: "README documents the new unit", checks: [] },
	],
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const refused = (plan: unknown): boolean => {
	try {
		validateEndoVerificationPlanV0(plan);
		return false;
	} catch {
		return true;
	}
};

// ---- the plan ---------------------------------------------------------------------------------------------------------------------

describe("a verification plan: its invariants make an invalid plan unrepresentable", () => {
	it("accepts a plan, criteria left to judgment included, and a plan with no check at all", () => {
		expect(validateEndoVerificationPlanV0(clone(PLAN))).toEqual(PLAN);
		expect(validateEndoVerificationPlanV0({ checks: [], criteria: [{ text: "Reads well", checks: [] }] })).toEqual({
			checks: [],
			criteria: [{ text: "Reads well", checks: [] }],
		});
	});

	it("refuses every broken invariant", () => {
		const cases: [string, (p: EndoVerificationPlanV0 & Record<string, unknown>) => void][] = [
			["an unknown member", (p) => Object.assign(p, { extra: 1 })],
			["no criterion", (p) => p.criteria.splice(0)],
			[
				"thirteen criteria",
				(p) => p.criteria.push(...Array.from({ length: 10 }, () => ({ text: "x", checks: [] }))),
			],
			[
				"nine checks",
				(p) => {
					for (let i = 0; i < 7; i += 1) p.checks.push({ name: `c${i}`, argv: ["true", String(i)], shows: "x" });
					p.criteria.push({ text: "all", checks: p.checks.map((c) => c.name) });
				},
			],
			["a name with a capital", (p) => Object.assign(p.checks[0]!, { name: "Unit" })],
			["two checks with one name", (p) => Object.assign(p.checks[1]!, { name: "unit" })],
			["two checks with one argv", (p) => Object.assign(p.checks[1]!, { argv: ["node", "--test"] })],
			["an empty argv", (p) => Object.assign(p.checks[0]!, { argv: [] })],
			["an empty executable", (p) => Object.assign(p.checks[0]!, { argv: ["", "x"] })],
			["a NUL in an argument", (p) => Object.assign(p.checks[0]!, { argv: ["node", "a\u0000b"] })],
			[
				"a bidirectional override in an argument",
				(p) => Object.assign(p.checks[0]!, { argv: ["node", "a\u202eb"] }),
			],
			["a line separator in an argument", (p) => Object.assign(p.checks[0]!, { argv: ["node", "a\u2028b"] })],
			["a newline in an argument", (p) => Object.assign(p.checks[0]!, { argv: ["node", "a\nb"] })],
			// The two characters the page's display-safe form puts in: a planned argument holding one could look like a receipt's cut or
			// cleaned argument, and the page could no longer count a check's receipts itself (Codex, #139).
			["a replacement character in an argument", (p) => Object.assign(p.checks[0]!, { argv: ["node", "a\ufffdb"] })],
			["an ellipsis in an argument", (p) => Object.assign(p.checks[0]!, { argv: ["node", "test\u2026"] })],
			["an argument the page would cut", (p) => Object.assign(p.checks[0]!, { argv: ["node", "x".repeat(401)] })],
			[
				"a check no criterion names",
				(p) => Object.assign(p.criteria[0]!, { checks: [] }) && p.criteria[1]!.checks.pop(),
			],
			["a criterion naming no check of the plan", (p) => p.criteria[2]!.checks.push("e2e")],
			["a criterion naming one check twice", (p) => p.criteria[0]!.checks.push("unit")],
			["a blank criterion", (p) => Object.assign(p.criteria[2]!, { text: "" })],
			["an untrimmed criterion", (p) => Object.assign(p.criteria[2]!, { text: " README " })],
			["a two-line criterion", (p) => Object.assign(p.criteria[2]!, { text: "a\nb" })],
			["a criterion over 280 characters", (p) => Object.assign(p.criteria[2]!, { text: "x".repeat(281) })],
			["a blank 'shows'", (p) => Object.assign(p.checks[0]!, { shows: "" })],
			["checks not a list", (p) => Object.assign(p, { checks: {} })],
			[
				"a plan over 16 KiB",
				(p) => {
					p.checks.splice(0);
					p.criteria.splice(0);
					for (let i = 0; i < 8; i += 1)
						p.checks.push({
							name: `c${i}`,
							argv: Array.from({ length: 6 }, (_, j) => `${i}${j}${"x".repeat(398)}`),
							shows: "x",
						});
					p.criteria.push({ text: "all", checks: p.checks.map((c) => c.name) });
				},
			],
		];
		for (const [name, change] of cases) {
			const p = clone(PLAN) as EndoVerificationPlanV0 & Record<string, unknown>;
			change(p);
			expect(refused(p), name).toBe(true);
		}
	});
});

// ---- the prepared record: v0 unchanged, v1 carries the plan --------------------------------------------------------------------------

function workspace() {
	const root = fresh("store");
	const tasks = new DevelopTasksStoreV0(root);
	const project = ok(tasks.registerProject({ name: "demo", path: fresh("project"), observedGitRoot: null }));
	const task = ok(
		tasks.createTask(
			project.id,
			{ title: "Add days", acceptance: "1. tests pass\n2. README documents d" },
			{ select: true },
		),
	);
	const service = new DevelopAttemptsServiceV0(tasks, new DevelopAttemptsStoreV0(root));
	return { root, tasks, project, task, service };
}

describe("the prepared record and its brief", () => {
	it("an attempt prepared without a plan is still v0, with brief v0: byte for byte what it was", () => {
		const w = workspace();
		const a = ok(w.service.prepare(w.project.id, w.task.id, { objective: "do it" }));
		expect(a.schemaVersion).toBe("endo.develop-attempt.v0");
		expect(a.brief).toBe("endo.develop-brief.v0");
		expect("verification" in a).toBe(false);
		const file = readFileSync(join(w.root, "develop", "attempts", `${a.id}.prepared.json`), "utf8");
		expect(file).not.toContain("verification");
		expect(renderEndoDevelopBriefV0(a)).not.toContain("How the result will be checked");
	});

	it("a plan makes a v1 record whose brief renders it, so the approved brief digest covers the plan", () => {
		const w = workspace();
		const a = ok(w.service.prepare(w.project.id, w.task.id, { objective: "do it", verification: clone(PLAN) }));
		expect([a.schemaVersion, a.brief]).toEqual(["endo.develop-attempt.v1", "endo.develop-brief.v1"]);
		expect(ok(w.service.get(a.id)).attempt).toEqual(a);
		const brief = renderEndoDevelopBriefV0(a);
		expect(brief).toContain("## How the result will be checked");
		expect(brief).toContain('```text\n["node","--test"]\n```');
		expect(brief).toContain("Check `unit`, the command as an argument list:");
		expect(brief).toContain(
			"Criterion 3:\n```text\nREADME documents the new unit\n```\nChecked by: the operator's judgment (no check).",
		);
		expect(brief).toContain("Checked by: `unit`, `lint`.");
		expect(brief).toContain("Your own report of running them is not taken as their result.");
		// Its sections otherwise are v0's, in v0's order, and it still begins and ends as every brief does.
		expect(brief.indexOf("## Constraints and exclusions")).toBeLessThan(
			brief.indexOf("## How the result will be checked"),
		);
		expect(brief.indexOf("## How the result will be checked")).toBeLessThan(brief.indexOf("## What to report back"));
		expect(brief.startsWith(`# Work brief ${a.id}\n`) && brief.endsWith(`End of brief ${a.id}.\n`)).toBe(true);
		// A changed plan is a different brief: the digest an operator approved does not survive an edit of it.
		const edited = clone(a) as EndoDevelopAttemptV0 & { verification: EndoVerificationPlanV0 };
		edited.verification.checks[0]!.argv = ["true"];
		expect(sha256HexV0(renderEndoDevelopBriefV0(edited))).not.toBe(sha256HexV0(brief));
	});

	it("version, brief renderer and plan go together; every other mix is refused", () => {
		const w = workspace();
		const v0 = ok(w.service.prepare(w.project.id, w.task.id, { objective: "do it" }));
		const v1 = ok(w.service.prepare(w.project.id, w.task.id, { objective: "do it", verification: clone(PLAN) }));
		const bad = (x: unknown) => () => validateEndoDevelopAttemptV0(x);
		expect(bad({ ...v0, verification: PLAN })).toThrow();
		expect(bad({ ...v0, brief: "endo.develop-brief.v1" })).toThrow();
		const { verification: _, ...v1bare } = v1 as EndoDevelopAttemptV0 & { verification: unknown };
		expect(bad(v1bare)).toThrow();
		expect(bad({ ...v1, brief: "endo.develop-brief.v0" })).toThrow();
		expect(bad({ ...v1, verification: { ...PLAN, checks: [] } })).toThrow();
		expect(bad({ ...v1, schemaVersion: "endo.develop-attempt.v2" })).toThrow();
	});

	it("an invalid plan is refused before anything is written, and the largest record still fits its bound", () => {
		const w = workspace();
		for (const verification of [null, {}, { ...PLAN, extra: true }, { checks: PLAN.checks, criteria: [] }])
			expect(w.service.prepare(w.project.id, w.task.id, { objective: "x", verification })).toEqual({
				ok: false,
				code: "bad-request",
			});
		expect(recordFiles(w.root)).toEqual([]);
		const big = ok(
			w.tasks.createTask(w.project.id, {
				title: "☃".repeat(120),
				description: "☃".repeat(4000),
				acceptance: '"'.repeat(4000),
			}),
		);
		const plan: EndoVerificationPlanV0 = { checks: [], criteria: [] };
		for (let i = 0; i < 8; i += 1)
			plan.checks.push({
				name: `c${i}`,
				argv: [`"${i}${'"'.repeat(150)}`, `\\${"\\".repeat(150)}`],
				shows: '"'.repeat(200),
			});
		for (let i = 0; i < 12; i += 1)
			plan.criteria.push({ text: `${i}${'"'.repeat(270)}`, checks: i === 0 ? plan.checks.map((c) => c.name) : [] });
		const a = ok(
			w.service.prepare(w.project.id, big.id, {
				objective: "☃".repeat(4000),
				constraints: "\n".repeat(4000),
				reportBack: "\\".repeat(4000),
				verification: validateEndoVerificationPlanV0(plan),
			}),
		);
		const size = readFileSync(join(w.root, "develop", "attempts", `${a.id}.prepared.json`)).length;
		expect(size).toBeLessThanOrEqual(ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxPreparedBytes);
		expect(ok(w.service.get(a.id)).attempt).toEqual(a);
	});
});

// ---- the ledger -------------------------------------------------------------------------------------------------------------------

const HEAD = "b".repeat(40);
const OLD = "a".repeat(40);
const WT = "/work/project";
const COMMON = "/work/project/.git";
const CLEAN: EndoReceiptCurrentV0 = { worktree: WT, commonDir: COMMON, commit: HEAD, clean: true };
let n = 0;
function receipt(
	argv: string[],
	o: { commit?: string; code?: number; at?: number; worktree?: string; commonDir?: string; timedOut?: boolean } = {},
): EndoDevelopReceiptV0 {
	n += 1;
	const commit = o.commit ?? HEAD;
	const facts = {
		execution: o.timedOut ? { kind: "timed-out" as const } : { kind: "exited" as const, code: o.code ?? 0 },
		escapedProcess: false,
		strayProcesses: false,
		after: {
			state: "observed" as const,
			sameRepository: true,
			commit,
			tree: "c".repeat(40),
			clean: true,
			reflogsUnchanged: true,
			rulesUnchanged: true,
		},
		revision: { commit, tree: "c".repeat(40), branch: "refs/heads/main" },
		reflog: "compared" as const,
		repository: { worktree: o.worktree ?? WT, commonDir: o.commonDir ?? COMMON, linked: false },
		check: { argv, executable: "/usr/bin/x", realExecutable: "/usr/bin/x", timeoutMs: 60_000 },
	};
	const at = o.at ?? n * 10;
	return {
		schemaVersion: "endo.develop-receipt.v0",
		id: `endo.receipt.${String(n).padStart(32, "0")}`,
		attemptId: `endo.attempt.${"0".repeat(32)}`,
		projectId: `endo.project.${"0".repeat(32)}`,
		requestedBy: "operator",
		via: "cli",
		observer: { tool: "endo", version: "test" },
		startedAtMs: at,
		endedAtMs: at + 5,
		durationMs: 5,
		output: { stdoutBytes: 0, stderrBytes: 0 },
		...facts,
		...endoReceiptVerdictV0(facts),
	};
}
const UNIT = ["node", "--test"];
const LINT = ["npm", "run", "lint"];
const ledger = (receipts: EndoDevelopReceiptV0[], current: EndoReceiptCurrentV0 | null = CLEAN) =>
	endoAcceptanceLedgerV0({ plan: PLAN, receipts, current });
const states = (l: ReturnType<typeof ledger>) => ({
	checks: Object.fromEntries(l.checks.map((c) => [c.name, c.state])),
	criteria: l.criteria.map((c) => c.state),
});

describe("the acceptance ledger: what has been observed at the current HEAD, per planned check and per criterion", () => {
	it("nothing run: every check not run, every criterion with a check not shown, judgment stays judgment", () => {
		expect(states(ledger([]))).toEqual({
			checks: { unit: "not-run", lint: "not-run" },
			criteria: ["not-shown", "not-shown", "judgment"],
		});
	});

	it("passes at HEAD, clean: a criterion is passed only when every one of its checks passed", () => {
		expect(states(ledger([receipt(UNIT)]))).toEqual({
			checks: { unit: "passed", lint: "not-run" },
			criteria: ["passed", "not-shown", "judgment"],
		});
		expect(states(ledger([receipt(UNIT), receipt(LINT)])).criteria).toEqual(["passed", "passed", "judgment"]);
	});

	it("a failure or an inconclusive result at HEAD decides the criterion, whatever else passed", () => {
		expect(states(ledger([receipt(UNIT), receipt(LINT, { code: 2 })])).criteria).toEqual([
			"passed",
			"failed",
			"judgment",
		]);
		expect(states(ledger([receipt(UNIT), receipt(LINT, { timedOut: true })])).criteria).toEqual([
			"passed",
			"inconclusive",
			"judgment",
		]);
	});

	it("re-running until it passes does not hide a failure at the same commit: the check is mixed, the criterion inconclusive", () => {
		const l = ledger([receipt(UNIT, { code: 1 }), receipt(UNIT, { code: 1 }), receipt(UNIT)]);
		const unit = l.checks[0]!;
		expect([unit.state, unit.current?.outcome, unit.atHead]).toEqual([
			"mixed",
			"passed",
			{ passed: 1, failed: 2, inconclusive: 0 },
		]);
		expect(l.criteria[0]!.state).toBe("inconclusive");
	});

	it("only the exact argv is the same check: a near match is unplanned, never counted", () => {
		const l = ledger([
			receipt(["node", "--test", ""]),
			receipt(["node --test"]),
			receipt(["node", "--test", "test/one.test.js"]),
			receipt(["node", "--Test"]),
		]);
		expect([l.checks[0]!.state, l.checks[0]!.runs, l.unplanned]).toEqual(["not-run", 0, 4]);
	});

	it("a later run at another commit never hides the result at HEAD; the other commit is shown beside it", () => {
		const l = ledger([
			receipt(UNIT, { code: 1, commit: OLD, at: 10 }),
			receipt(UNIT, { at: 20 }),
			receipt(UNIT, { commit: OLD, at: 30 }),
		]);
		const unit = l.checks[0]!;
		expect([
			unit.state,
			unit.current?.commit,
			unit.otherCommit?.commit,
			unit.otherCommit?.outcome,
			unit.runs,
		]).toEqual(["passed", HEAD, OLD, "passed", 3]);
	});

	it("only at another commit: stale, never applied to HEAD (an amended commit with the same tree included)", () => {
		const l = ledger([receipt(UNIT, { commit: OLD })]);
		expect([l.checks[0]!.state, l.checks[0]!.current, l.checks[0]!.otherCommit?.commit]).toEqual([
			"stale",
			null,
			OLD,
		]);
		expect(l.criteria[0]!.state).toBe("not-shown");
	});

	it("only in another working tree or repository: elsewhere, never compared", () => {
		for (const where of [{ worktree: "/work/linked" }, { commonDir: "/other/.git" }]) {
			const l = ledger([receipt(UNIT, where)]);
			expect([l.checks[0]!.state, l.checks[0]!.current, l.checks[0]!.otherCommit, l.checks[0]!.runs]).toEqual([
				"elsewhere",
				null,
				null,
				1,
			]);
		}
		// A pass in another tree does not stand beside a failure here either.
		expect(
			ledger([receipt(UNIT, { code: 1 }), receipt(UNIT, { worktree: "/work/linked", at: 999 })]).checks[0]!.state,
		).toBe("failed");
	});

	it("the tree has changed since: neither a pass nor a failure at HEAD is counted; the outcome is kept to show", () => {
		for (const code of [0, 1]) {
			const l = ledger([receipt(UNIT, { code }), receipt(LINT)], { ...CLEAN, clean: false });
			expect([l.checks[0]!.state, l.checks[0]!.current?.outcome]).toEqual([
				"tree-changed",
				code === 0 ? "passed" : "failed",
			]);
			expect(l.criteria.map((c) => c.state)).toEqual(["not-shown", "not-shown", "judgment"]);
		}
	});

	it("the tree could not be read: every check unavailable, never not-run, never a result", () => {
		const l = ledger([receipt(UNIT), receipt(LINT, { code: 1 })], null);
		expect(states(l)).toEqual({
			checks: { unit: "unavailable", lint: "unavailable" },
			criteria: ["unavailable", "unavailable", "judgment"],
		});
		expect(l.checks.every((c) => c.current === null && c.otherCommit === null)).toBe(true);
	});

	it("the view's ledger without readable receipts is unavailable too: an unreadable directory is not 'not run'", () => {
		const w = workspace();
		const a = ok(w.service.prepare(w.project.id, w.task.id, { objective: "x", verification: clone(PLAN) }));
		const v = endoAttemptVerificationViewV0(a, null, CLEAN);
		expect(v?.checks.map((c) => c.state)).toEqual(["unavailable", "unavailable"]);
		expect(
			endoAttemptVerificationViewV0(ok(w.service.prepare(w.project.id, w.task.id, { objective: "x" })), [], CLEAN),
		).toBeNull();
	});

	it("the evidence reading with unreadable receipts compares nothing: unavailable, never not-run", () => {
		const w = workspace();
		const a = ok(w.service.prepare(w.project.id, w.task.id, { objective: "x", verification: clone(PLAN) }));
		const e = endoAttemptEvidenceV0({
			report: ok(w.service.get(a.id)),
			task: { status: "review", history: [] },
			receipts: null,
			receiptProblems: 0,
			comparedWith: WT,
			current: CLEAN,
			readAtMs: 1,
		});
		expect(e.verification?.checks.map((c) => c.state)).toEqual(["unavailable", "unavailable"]);
		expect(e.verification?.criteria.map((c) => c.state)).toEqual(["unavailable", "unavailable", "judgment"]);
		expect(e.gaps.map((g) => g.code)).toEqual(
			expect.arrayContaining(["receipts-unreadable", "planned-check-not-passed-at-current-head"]),
		);
	});

	it("receipts of commands not in the plan are counted, and change no state", () => {
		const l = ledger([receipt(["sh", "-c", "exit 0"]), receipt(["make"], { code: 1 })]);
		expect([l.unplanned, states(l).criteria]).toEqual([2, ["not-shown", "not-shown", "judgment"]]);
	});
});

describe("the criterion rule and its labels, mirrored by the page (a contract test)", () => {
	it("the page's rule is the protocol's, for every combination of up to three check states", () => {
		const combos: EndoPlannedCheckStateV0[][] = [[]];
		for (let len = 1; len <= 3; len += 1)
			for (const prefix of combos.filter((c) => c.length === len - 1))
				for (const s of ENDO_PLANNED_CHECK_STATES_V0) combos.push([...prefix, s]);
		for (const c of combos) expect(criterionState(c), c.join(",")).toBe(endoCriterionStateV0(c));
		expect(combos.length).toBe(1 + 9 + 81 + 729);
	});

	it("the labels and sentences are the protocol's, and none says met, verified or done", () => {
		expect(CRITERION_LABELS).toEqual(ENDO_CRITERION_LABELS_V0);
		expect(CRITERION_TEXT).toEqual(ENDO_CRITERION_TEXT_V0);
		expect(PLANNED_CHECK_LABELS).toEqual(ENDO_PLANNED_CHECK_LABELS_V0);
		expect(Object.keys(CRITERION_LABELS).sort()).toEqual([...ENDO_CRITERION_STATES_V0].sort());
		for (const text of [
			...Object.values(ENDO_CRITERION_LABELS_V0),
			...Object.values(ENDO_CRITERION_TEXT_V0),
			...Object.values(ENDO_PLANNED_CHECK_LABELS_V0),
		])
			expect(text).not.toMatch(/\bmet\b|verified|satisf|\bdone\b|succe/i);
	});
});

// ---- the page's gate ----------------------------------------------------------------------------------------------------------------

/** The working tree each view below was compared with, so its body carries the same HEAD (the page checks every relation against it). */
const COMPARED = new WeakMap<object, EndoReceiptCurrentV0 | null>();

/** One attempt as the view carries it, built by the real view code from synthetic receipts. */
function viewWith(
	receipts: EndoDevelopReceiptV0[],
	current: EndoReceiptCurrentV0 | null = CLEAN,
): EndoDevelopAttemptViewV5 {
	const w = workspace();
	const a = ok(w.service.prepare(w.project.id, w.task.id, { objective: "x", verification: clone(PLAN) }));
	const view: EndoDevelopAttemptViewV5 = {
		id: a.id,
		state: "prepared",
		preparedAtMs: a.preparedAtMs,
		taskRevision: a.task.revision,
		objective: "x",
		handoff: null,
		outcome: null,
		taskWordsChanged: [],
		brief: renderEndoDevelopBriefV0(a),
		receipts: {
			state: "ready",
			list: receipts.map((r) => ({
				id: r.id,
				startedAtMs: r.startedAtMs,
				endedAtMs: r.endedAtMs,
				argv: [...r.check.argv],
				commit: r.revision.commit,
				branch: r.revision.branch,
				execution: r.execution,
				outcome: r.outcome,
				reasons: [...r.reasons],
				limitations: [...r.limitations],
				relation: endoReceiptRelationV0(r, current),
			})),
			problems: 0,
		},
		execution: null,
		verification: endoAttemptVerificationViewV0(a, receipts, current),
		provenance: null,
	};
	COMPARED.set(view, current);
	return view;
}
const body = (a: EndoDevelopAttemptViewV5) => {
	const current = COMPARED.has(a) ? (COMPARED.get(a) ?? null) : CLEAN;
	return clone({
		schemaVersion: "endo.develop-attempts-view.v5",
		state: "ready",
		taskId: `endo.task.${"0".repeat(32)}`,
		attempts: [a],
		problems: 0,
		head: { readAtMs: 1, commit: current?.commit ?? null, clean: current?.clean ?? null },
	});
};

describe("the page's gate re-derives the ledger and refuses any claim the receipts beside it do not show", () => {
	const mixed = [receipt(UNIT, { code: 1 }), receipt(UNIT), receipt(LINT, { commit: OLD }), receipt(["make"])];

	it("accepts real views in every state", () => {
		for (const [receipts, current] of [
			[[], CLEAN],
			[mixed, CLEAN],
			[[receipt(UNIT), receipt(LINT)], CLEAN],
			[[receipt(UNIT, { code: 1 }), receipt(LINT, { timedOut: true })], CLEAN],
			[[receipt(UNIT), receipt(LINT, { worktree: "/elsewhere" })], CLEAN],
			[[receipt(UNIT)], { ...CLEAN, clean: false }],
			[[receipt(UNIT)], null],
		] as const) {
			const a = viewWith([...receipts], current);
			expect(readAttempts(body(a)), JSON.stringify(a.verification?.checks.map((c) => c.state))).not.toBeNull();
		}
	});

	it("refuses each forgery", () => {
		const forgeries: [string, (a: EndoDevelopAttemptViewV5) => void][] = [
			[
				"a criterion claiming passed over a not-run check",
				(a) => Object.assign(a.verification!.criteria[1]!, { state: "passed" }),
			],
			["judgment turned into passed", (a) => Object.assign(a.verification!.criteria[2]!, { state: "passed" })],
			["a mixed check claiming passed", (a) => Object.assign(a.verification!.checks[0]!, { state: "passed" })],
			[
				"a mixed check without a disagreement",
				(a) => Object.assign(a.verification!.checks[0]!.atHead, { failed: 0 }),
			],
			[
				"a stale check claiming passed with its other-commit receipt as current",
				(a) => {
					const c = a.verification!.checks[1]!;
					Object.assign(c, {
						state: "passed",
						current: c.otherCommit,
						atHead: { passed: 1, failed: 0, inconclusive: 0 },
					});
				},
			],
			[
				"a current receipt not in the list",
				(a) => Object.assign(a.verification!.checks[0]!.current!, { receiptId: `endo.receipt.${"f".repeat(32)}` }),
			],
			[
				"a current receipt of another command",
				(a) => Object.assign(a.verification!.checks[0]!.current!, { receiptId: a.receipts.list[3]!.id }),
			],
			[
				"a current receipt with a different outcome",
				(a) => Object.assign(a.verification!.checks[0]!.current!, { outcome: "failed" }),
			],
			[
				"a stale check without its other commit",
				(a) => Object.assign(a.verification!.checks[1]!, { otherCommit: null }),
			],
			["a check named by no criterion", (a) => a.verification!.criteria[1]!.checks.pop()],
			["a criterion naming an unknown check", (a) => a.verification!.criteria[2]!.checks.push("e2e")],
			[
				"a not-run check with runs",
				(a) => Object.assign(a.verification!.checks[1]!, { state: "not-run", otherCommit: null }),
			],
			["more unplanned receipts than receipts", (a) => Object.assign(a.verification!, { unplanned: 99 })],
			[
				"an argv the page would refuse",
				(a) => Object.assign(a.verification!.checks[0]!, { argv: ["node", "a\u202eb"] }),
			],
			["two checks with one argv", (a) => Object.assign(a.verification!.checks[1]!, { argv: UNIT })],
			[
				"a receipt's relation moved off HEAD",
				(a) => Object.assign(a.receipts.list[1]!, { relation: "head-differs" }),
			],
			// Codex, #139: a disagreement dropped from the counts, so the check and its criterion read as a clean pass.
			[
				"a mixed check claiming passed, its failure dropped from the counts",
				(a) => {
					Object.assign(a.verification!.checks[0]!, {
						state: "passed",
						atHead: { passed: 1, failed: 0, inconclusive: 0 },
					});
					// Every criterion re-derived consistently from the forged states, as Codex's payload did: only the counts can tell.
					Object.assign(a.verification!.criteria[0]!, { state: "passed" });
					Object.assign(a.verification!.criteria[1]!, { state: "not-shown" });
				},
			],
			["a run dropped from a check's count", (a) => Object.assign(a.verification!.checks[0]!, { runs: 1 })],
			["an unplanned receipt hidden", (a) => Object.assign(a.verification!, { unplanned: 0 })],
		];
		for (const [name, forge] of forgeries) {
			const a = viewWith([...mixed]);
			expect(readAttempts(body(a)), "untouched").not.toBeNull();
			forge(a);
			expect(readAttempts(body(a)), name).toBeNull();
		}
		// And the coherence check alone, for a view with no plan: nothing to check.
		expect(verificationCoherent({ receipts: { state: "ready", list: [], problems: 0 }, verification: null })).toBe(
			true,
		);
	});

	it("a result in a tree that has changed since cannot be claimed as a current pass", () => {
		const a = viewWith([receipt(UNIT), receipt(LINT)], { ...CLEAN, clean: false });
		expect(a.verification?.checks.map((c) => c.state)).toEqual(["tree-changed", "tree-changed"]);
		expect(readAttempts(body(a))).not.toBeNull();
		for (const c of a.verification!.checks) c.state = "passed";
		for (const c of a.verification!.criteria) c.state = c.checks.length === 0 ? "judgment" : "passed";
		expect(readAttempts(body(a))).toBeNull();
	});

	it("the largest brief a plan can produce is still one the page accepts (Codex, #139)", () => {
		const w = workspace();
		const ticks = (n: number) => "`".repeat(n);
		const big = ok(
			w.tasks.createTask(
				w.project.id,
				{ title: ticks(120), description: ticks(4000), acceptance: ticks(4000) },
				{ select: true },
			),
		);
		// Every text a run of backticks, so each fence is as long as it can be; the plan as close to 16 KiB as the validator allows.
		const plan: EndoVerificationPlanV0 = { checks: [], criteria: [] };
		for (let i = 0; i < 8; i += 1)
			plan.checks.push({ name: `c${i}`, argv: [`${i}${ticks(399)}`, ticks(400), ticks(400)], shows: ticks(280) });
		for (let i = 0; i < 12; i += 1)
			plan.criteria.push({
				text: `${String.fromCharCode(97 + i)}${ticks(279)}`,
				checks: i === 0 ? plan.checks.map((c) => c.name) : [],
			});
		expect(refused(plan)).toBe(false);
		const size = new TextEncoder().encode(JSON.stringify(plan)).length;
		expect(size).toBeGreaterThan(14 * 1024);
		const a = ok(
			w.service.prepare(w.project.id, big.id, {
				objective: ticks(4000),
				constraints: ticks(4000),
				reportBack: ticks(4000),
				verification: plan,
			}),
		);
		const brief = renderEndoDevelopBriefV0(a);
		expect(brief.length).toBeGreaterThan(64_000);
		const view = { ...viewWith([]), id: a.id, brief, verification: endoAttemptVerificationViewV0(a, [], CLEAN) };
		expect(readAttempts(body(view))).not.toBeNull();
		expect(brief.length).toBeLessThan(160_000);
	});

	it("an unavailable ledger cannot sit beside a result", () => {
		const a = viewWith([receipt(UNIT)], null);
		Object.assign(a.verification!.checks[1]!, { state: "not-run" });
		Object.assign(a.verification!.criteria[1]!, { state: "not-shown" });
		expect(readAttempts(body(a))).toBeNull();
	});
});

// ---- end to end: real Git, the real CLI --------------------------------------------------------------------------------------------

describe.skipIf(!haveGit)(
	"end to end: prepare with a plan, run checks with --, read the ledger in the terminal and the view",
	() => {
		const HOME = fresh("home");
		const endo = (args: string[]) =>
			spawnSync(process.execPath, [CLI, ...args], {
				cwd: base,
				encoding: "utf8",
				env: { ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, ".config") },
				timeout: 60_000,
			});
		const snapshot = (root: string) => {
			const dir = join(root, "develop", "attempts");
			return Object.fromEntries(
				[join(root, "develop", "tasks.json"), ...readdirSync(dir).map((f) => join(dir, f))].map((p) => [
					p,
					readFileSync(p, "utf8"),
				]),
			);
		};

		it("a baseline failure, a fix, a pass at HEAD, a criterion left to judgment, and a stale check after a new commit", () => {
			const root = fresh("store");
			const project = fresh("repo");
			git(project, "init", "-q", "-b", "main");
			writeFileSync(join(project, "unit.sh"), "exit 1\n");
			writeFileSync(join(project, "lint.sh"), "exit 0\n");
			git(project, "add", ".");
			git(project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
			const p = JSON.parse(
				endo(["project", "add", "--root", root, "--name", "demo", "--path", project]).stdout,
			).project;
			const t = JSON.parse(endo(["task", "add", "--root", root, "--project", p.id, "--title", "Fix"]).stdout).task;
			// The page shows the task the project has selected (a choice made on the page; here, in the store, before the snapshot below).
			ok(new DevelopTasksStoreV0(root).selectTask(p.id, t.id));
			const planFile = join(fresh("plan"), "plan.json");
			const plan: EndoVerificationPlanV0 = {
				checks: [
					{ name: "unit", argv: ["sh", "unit.sh"], shows: "the unit script exits 0" },
					{ name: "lint", argv: ["sh", "lint.sh"], shows: "the lint script exits 0" },
				],
				criteria: [
					{ text: "Unit tests pass", checks: ["unit"] },
					{ text: "Lint is clean and tests pass", checks: ["unit", "lint"] },
					{ text: "The README says how", checks: [] },
				],
			};
			// Refusals first: nothing is written for a file that is not a plan.
			for (const [content, why] of [
				["{not json", "not JSON"],
				[JSON.stringify({ ...plan, checks: [] }), "names no check"],
				[
					JSON.stringify({ ...plan, checks: [{ ...plan.checks[0], argv: ["sh", "a\u202eb"] }, plan.checks[1]] }),
					"cannot be shown exactly",
				],
			]) {
				writeFileSync(planFile, content as string);
				const r = endo([
					"attempt",
					"prepare",
					"--root",
					root,
					"--project",
					p.id,
					"--task",
					t.id,
					"--objective",
					"x",
					"--plan-file",
					planFile,
				]);
				expect([r.status, r.stderr], why).toEqual([1, expect.stringContaining(why as string)]);
			}
			expect(recordFiles(root)).toEqual([]);
			writeFileSync(planFile, JSON.stringify(plan));
			const prepared = endo([
				"attempt",
				"prepare",
				"--root",
				root,
				"--project",
				p.id,
				"--task",
				t.id,
				"--objective",
				"Fix unit",
				"--plan-file",
				planFile,
			]);
			expect(prepared.status).toBe(0);
			const id = JSON.parse(prepared.stdout).attempt.attempt.id as string;
			expect(endo(["attempt", "brief", "--root", root, "--attempt", id]).stdout).toContain('["sh","unit.sh"]');
			const records = snapshot(root);

			const check = (...argv: string[]) =>
				endo(["attempt", "check", "--root", root, "--attempt", id, "--", ...argv]).status;
			expect(check("sh", "unit.sh")).toBe(3); // the baseline fails
			writeFileSync(join(project, "unit.sh"), "exit 0\n");
			git(project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-am", "fix");
			expect(check("sh", "unit.sh")).toBe(0);
			expect(check("sh", "-c", "exit 0")).toBe(0); // not in the plan

			const read = () => JSON.parse(endo(["attempt", "evidence", "--root", root, "--attempt", id]).stdout).evidence;
			let e = read();
			expect(e.schemaVersion).toBe("endo.develop-attempt-evidence.v3");
			expect(e.verification.checks.map((c: { name: string; state: string }) => [c.name, c.state])).toEqual([
				["unit", "passed"],
				["lint", "not-run"],
			]);
			expect(e.verification.checks[0].otherCommit.outcome).toBe("failed");
			expect(e.verification.criteria.map((c: { state: string }) => c.state)).toEqual([
				"passed",
				"not-shown",
				"judgment",
			]);
			expect(e.verification.unplanned).toBe(1);
			expect(e.gaps.map((g: { code: string }) => g.code)).toContain("planned-check-not-passed-at-current-head");
			const text = endo(["attempt", "evidence", "--root", root, "--attempt", id]).stderr;
			expect(text).toContain('  planned   [observed] unit ["sh","unit.sh"]: Passed at HEAD');
			expect(text).toContain("  criterion [plan: your judgment] 3. The README says how: Your judgment");

			expect(check("sh", "lint.sh")).toBe(0);
			e = read();
			expect(e.verification.criteria.map((c: { state: string }) => c.state)).toEqual([
				"passed",
				"passed",
				"judgment",
			]);
			expect(e.gaps.map((g: { code: string }) => g.code)).not.toContain("planned-check-not-passed-at-current-head");

			// The workbench's view, as the page reads it, through the page's own gate.
			const observer = new GitRevisionObserverV0({ env: { HOME } });
			return observer.observe(project, { within: true }).then((seen) => {
				if (!seen.ok) throw new Error("unobservable");
				const current = {
					worktree: seen.observation.worktree,
					commonDir: seen.observation.commonDir,
					commit: seen.observation.commit,
					clean: seen.observation.dirty.length === 0,
				};
				const service = new DevelopAttemptsServiceV0(
					new DevelopTasksStoreV0(root),
					new DevelopAttemptsStoreV0(root),
				);
				const view = service.viewFor(p.id, { store: new DevelopReceiptsStoreV0(root), current });
				const page = readAttempts(clone(view));
				expect(page?.attempts[0]?.verification?.criteria.map((c) => c.state)).toEqual([
					"passed",
					"passed",
					"judgment",
				]);
				// A new commit: everything that passed is stale, nothing carried forward.
				writeFileSync(join(project, "README"), "how\n");
				git(project, "add", "README");
				git(project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "docs");
				e = read();
				expect(e.verification.checks.map((c: { state: string }) => c.state)).toEqual(["stale", "stale"]);
				expect(e.verification.criteria.map((c: { state: string }) => c.state)).toEqual([
					"not-shown",
					"not-shown",
					"judgment",
				]);
				// None of it wrote the task file or an attempt record.
				expect(snapshot(root)).toEqual(records);
			});
		});
	},
);
