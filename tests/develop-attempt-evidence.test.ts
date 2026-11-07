// `endo attempt evidence` (docs/designs/develop-attempt-evidence.md): the pure reading, case by case. The end-to-end readings (fake Pi in a
// real PTY, and an installed Pi) are in tests/work-cycle-001a.test.ts.
import { describe, expect, it } from "vitest";
import type { EndoDevelopAttemptExecutionViewV0 } from "../protocol/develop-attempt-execution.ts";
import {
	type EndoDevelopReceiptV0,
	type EndoReceiptCurrentV0,
	endoReceiptRelationV0,
	endoReceiptVerdictV0,
} from "../protocol/develop-receipts.ts";
import type { EndoDevelopStatusChangeV0, EndoDevelopTaskStatusV0 } from "../protocol/develop-tasks.ts";
import {
	type EndoAttemptEvidenceInputV0,
	endoAttemptEvidenceV0,
	renderEndoAttemptEvidenceV0,
} from "../runtime/contracts/develop-attempt-evidence.ts";
import type { DevelopAttemptReportV0 } from "../runtime/contracts/develop-attempts.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const TREE = "c".repeat(40);
const WT = "/work/project";
const COMMON = "/work/project/.git";
const AUTH_AT = 10_000;

function report(execution: Partial<EndoDevelopAttemptExecutionViewV0> | null): DevelopAttemptReportV0 {
	return {
		attempt: {
			id: "endo.attempt.0123456789abcdef0123456789abcdef",
			projectId: "endo.project.p",
			taskId: "endo.task.t",
			preparedAtMs: 1_000,
			task: { revision: 2, projectName: "p", title: "t", description: "d", acceptance: "a" },
			objective: "Fix slugify\nsecond line",
		},
		handoff: null,
		outcome: null,
		authorized: null,
		state: "prepared",
		task: "present",
		taskWordsChanged: [],
		// As the service reports a directory read whole: the authorisation is recorded exactly when there is an execution reading.
		records: { handoff: "absent", outcome: "absent", authorized: execution === null ? "absent" : "recorded" },
		damaged: [],
		unattributedWorkbenchSends: null,
		execution:
			execution === null
				? null
				: ({
						authorizedAtMs: AUTH_AT,
						session: "endo.session.pi.x",
						attachment: "att",
						taskRevision: 2,
						send: "runtime-accepted",
						refusal: null,
						disposition: "started",
						run: "completed",
						evidence: "complete",
						brief: "matches",
						...execution,
					} as EndoDevelopAttemptExecutionViewV0),
	} as unknown as DevelopAttemptReportV0;
}

let n = 0;
function receipt(commit: string, code: number, startedAtMs: number, worktree = WT): EndoDevelopReceiptV0 {
	n += 1;
	const facts = {
		execution: { kind: "exited" as const, code },
		escapedProcess: false,
		strayProcesses: false,
		after: {
			state: "observed" as const,
			sameRepository: true,
			commit,
			tree: TREE,
			clean: true,
			reflogsUnchanged: true,
			rulesUnchanged: true,
		},
		revision: { commit, tree: TREE, branch: "main" },
		reflog: "compared" as const,
		repository: { worktree, commonDir: COMMON, linked: worktree !== WT },
		check: {
			argv: ["node", "--test"],
			executable: "/usr/bin/node",
			realExecutable: "/usr/bin/node",
			timeoutMs: 60_000,
		},
	};
	return {
		schemaVersion: "endo.develop-receipt.v0",
		id: `endo.receipt.${String(n).padStart(32, "0")}`,
		attemptId: "endo.attempt.0123456789abcdef0123456789abcdef",
		projectId: "endo.project.p",
		requestedBy: "operator",
		via: "cli",
		observer: { tool: "endo", version: "test" },
		startedAtMs,
		endedAtMs: startedAtMs + 5,
		durationMs: 5,
		output: { stdoutBytes: 0, stderrBytes: 0 },
		...facts,
		...endoReceiptVerdictV0(facts),
	};
}

const history = (...to: EndoDevelopTaskStatusV0[]): EndoDevelopStatusChangeV0[] =>
	to.map((s, i) => ({
		atMs: 20_000 + i,
		from: i === 0 ? null : (to[i - 1] ?? null),
		to: s,
		note: s === "done" ? "read it" : null,
	}));

function read(o: {
	execution?: Partial<EndoDevelopAttemptExecutionViewV0> | null;
	receipts?: EndoDevelopReceiptV0[] | null;
	current?: EndoReceiptCurrentV0 | null;
	status?: EndoDevelopTaskStatusV0 | null;
	history?: EndoDevelopStatusChangeV0[];
}) {
	const current = o.current === undefined ? { worktree: WT, commonDir: COMMON, commit: B, clean: true } : o.current;
	const receipts = o.receipts === undefined ? [] : o.receipts;
	const input: EndoAttemptEvidenceInputV0 = {
		report: report(o.execution === undefined ? {} : o.execution),
		task:
			o.status === null
				? null
				: {
						status: o.status ?? "open",
						history:
							o.history ??
							history(...(o.status === "done" ? (["open", "review", "done"] as const) : (["open"] as const))),
					},
		receipts:
			receipts === null ? null : receipts.map((r) => ({ receipt: r, relation: endoReceiptRelationV0(r, current) })),
		receiptProblems: 0,
		comparedWith: WT,
		current,
		readAtMs: 99_000,
	};
	const view = endoAttemptEvidenceV0(input);
	return { view, gaps: view.gaps.map((g) => g.code) };
}

describe("endo attempt evidence: the reading", () => {
	it("never names a candidate revision, and always lists what no record establishes", () => {
		const { view } = read({ receipts: [receipt(B, 0, AUTH_AT + 100)] });
		expect(view.candidate).toMatchObject({ source: "none", recorded: false, checkedCommits: [B] });
		// Exactly these members: a reader that added an inferred candidate (the latest passing commit, say) fails here.
		expect(Object.keys(view.candidate).sort()).toEqual(["checkedCommits", "recorded", "source", "text"]);
		expect(view.notEstablished.join(" ")).toMatch(/No record names one/);
		expect(view.notEstablished.join(" ")).toMatch(/not authorship/);
		expect(view.attempt.source).toBe("operator");
		expect(view.sent.source).toBe("observed");
		expect(view.pi.source).toBe("pi-report");
		expect(view.checks).toMatchObject({ source: "observed", linkedBy: "operator" });
		expect(view.operator.source).toBe("operator");
		expect(JSON.stringify(view)).not.toMatch(/"produced"|"author"|"verified":/);
	});

	it("a normal cycle at the current HEAD leaves only the operator's acceptance missing, and the decision is shown as theirs", () => {
		const open = read({ receipts: [receipt(A, 3, 5_000), receipt(B, 0, AUTH_AT + 100)] });
		expect(open.gaps).toEqual(["not-accepted"]);
		expect(open.view.checks.latest).toHaveLength(1);
		expect(open.view.checks.latest[0]).toMatchObject({
			commit: B,
			outcome: "passed",
			relation: "at-head",
			authorization: "after",
			others: { passed: 0, failed: 1, inconclusive: 0 },
		});
		expect(open.view.candidate.checkedCommits).toEqual([A, B]);
		const done = read({ receipts: [receipt(B, 0, AUTH_AT + 100)], status: "done" });
		expect(done.gaps).toEqual([]);
		expect(done.view.operator).toMatchObject({ status: "done", movedToDone: { note: "read it" } });
		expect(renderEndoAttemptEvidenceV0(done.view)).toMatch(
			/decision {2}\[operator\] status done, moved to done \("read it"\)/,
		);
	});

	it("an attempt prepared but never authorised has no send, no run, and says so", () => {
		const { view, gaps } = read({ execution: null });
		expect(view.sent).toMatchObject({ authorizedAtMs: null, send: null, approvedOn: null });
		expect(view.pi).toMatchObject({ source: "none", run: null });
		expect(view.sent.sendLabel).toBe("No send to Pi through the workbench was authorised for this attempt");
		expect(gaps).toEqual(["not-authorized", "no-check", "not-accepted"]);
	});

	it("authorisation without a confirmed send, and a send whose run did not complete, are both gaps", () => {
		expect(read({ execution: { send: "no-send-recorded", disposition: null, run: "not-observed" } }).gaps).toEqual(
			expect.arrayContaining(["send-not-confirmed", "run-not-completed"]),
		);
		expect(read({ execution: { send: "sent-no-reply", disposition: null, run: "not-observed" } }).gaps).toContain(
			"send-not-confirmed",
		);
		for (const run of ["interrupted", "failed", "aborted", "open", "process-ended"] as const) {
			const { gaps, view } = read({ execution: { run } });
			expect(gaps).toContain("run-not-completed");
			expect(gaps).not.toContain("send-not-confirmed");
			expect(view.pi.run).toBe(run);
		}
		expect(read({ execution: { evidence: "partial" } }).gaps).toContain("execution-evidence-incomplete");
		expect(read({ execution: { brief: "differs" } }).gaps).toContain("brief-changed-since-authorization");
	});

	it("missing, failed and inconclusive checks at HEAD are gaps; a pass elsewhere does not hide a failure at HEAD", () => {
		expect(read({}).gaps).toContain("no-check");
		expect(read({ receipts: null }).gaps).toContain("receipts-unreadable");
		expect(read({ receipts: [receipt(B, 3, AUTH_AT + 1)] }).gaps).toContain("check-not-passed-at-current-head");
		const inconclusive = receipt(B, 0, AUTH_AT + 1);
		inconclusive.execution = { kind: "timed-out" };
		inconclusive.outcome = "inconclusive";
		inconclusive.reasons = ["timed-out"];
		const r = read({ receipts: [inconclusive] });
		expect(r.gaps).toContain("check-not-passed-at-current-head");
		expect(r.view.checks.latest[0]?.reasons).toEqual(["it ran past its time limit and was stopped"]);
		// A pass recorded LATER at an older commit never stands for the failure at the current HEAD.
		const mixed = read({ receipts: [receipt(B, 3, AUTH_AT + 1), receipt(A, 0, AUTH_AT + 50)] });
		expect(mixed.view.checks.latest[0]).toMatchObject({ commit: B, outcome: "failed" });
		expect(mixed.gaps).toContain("check-not-passed-at-current-head");
	});

	it("a pass at one commit does not apply to a clean but different HEAD: stale, and the current revision is unchecked", () => {
		const { view, gaps } = read({
			receipts: [receipt(A, 0, AUTH_AT + 1)],
			current: { worktree: WT, commonDir: COMMON, commit: B, clean: true },
			status: "done",
		});
		expect(view.checks.latest[0]).toMatchObject({ commit: A, outcome: "passed", relation: "head-differs" });
		expect(view.checks.latest[0]?.relationLabel).toMatch(/^Stale/);
		expect(gaps).toEqual(["no-check-at-current-head", "stale-check"]);
		// The operator's decision is reported as it is: the stale check does not reopen the task, nor does the done hide the gap.
		expect(view.operator.status).toBe("done");
	});

	it("the checked revision differing from the tree now: uncommitted changes, another worktree, or no observation at all", () => {
		expect(
			read({
				receipts: [receipt(B, 0, AUTH_AT + 1)],
				current: { worktree: WT, commonDir: COMMON, commit: B, clean: false },
			}).gaps,
		).toEqual(["current-tree-changed", "not-accepted"]);
		const elsewhere = read({ receipts: [receipt(B, 0, AUTH_AT + 1, "/work/other")] });
		expect(elsewhere.gaps).toEqual(expect.arrayContaining(["checked-in-another-tree", "no-check-at-current-head"]));
		expect(read({ receipts: [receipt(B, 0, AUTH_AT + 1)], current: null }).gaps).toContain(
			"current-tree-unavailable",
		);
	});

	it("checks are ordered against the authorisation by their start and end: only checks that ended before it are 'before'", () => {
		// receipt() ends 5 ms after it starts.
		const before = read({ receipts: [receipt(B, 0, AUTH_AT - 6)] });
		expect(before.view.checks.latest[0]?.authorization).toBe("before");
		expect(before.gaps).toContain("no-check-after-authorization");
		// Started before, ended after (and ending exactly at the authorisation is not "before"): it overlapped the send.
		for (const start of [AUTH_AT - 3, AUTH_AT - 5]) {
			const overlap = read({ receipts: [receipt(B, 0, start)] });
			expect(overlap.view.checks.latest[0]?.authorization).toBe("overlapping");
			expect(overlap.gaps).not.toContain("no-check-after-authorization");
		}
		expect(read({ receipts: [receipt(B, 0, AUTH_AT)] }).view.checks.latest[0]?.authorization).toBe("after");
		// Without an authorisation there is nothing to order by.
		expect(read({ execution: null, receipts: [receipt(B, 0, 1)] }).view.checks.latest[0]?.authorization).toBeNull();
	});

	it("receipt files that are not usable are a gap, so a damaged failure cannot leave a clean-looking reading", () => {
		const pass = [receipt(B, 0, AUTH_AT + 1)];
		expect(read({ receipts: pass, status: "done" }).gaps).toEqual([]);
		const damaged = endoAttemptEvidenceV0({
			report: report({}),
			task: { status: "done", history: history("open", "review", "done") },
			receipts: pass.map((r) => ({ receipt: r, relation: "at-head" as const })),
			receiptProblems: 1,
			comparedWith: WT,
			current: { worktree: WT, commonDir: COMMON, commit: B, clean: true },
			readAtMs: 1,
		});
		expect(damaged.gaps.map((g) => g.code)).toEqual(["receipt-files-unusable"]);
		expect(renderEndoAttemptEvidenceV0(damaged)).toContain("1 file(s) are not usable receipts and are not shown");
	});

	it("a command whose latest check is stale is a gap even when another command passed at HEAD", () => {
		const other = receipt(B, 0, AUTH_AT + 9);
		other.check = { ...other.check, argv: ["node", "-e", "0"] };
		const { view, gaps } = read({ receipts: [receipt(A, 0, AUTH_AT + 1), other] });
		expect(view.checks.latest.map((c) => [c.command, c.relation])).toEqual([
			["node --test", "head-differs"],
			["node -e 0", "at-head"],
		]);
		expect(gaps).toEqual(["stale-check", "not-accepted"]);
	});

	it("words changed since preparation, and the LAST move to done, are what is shown", () => {
		const r = report({});
		(r as { taskWordsChanged: unknown[] }).taskWordsChanged = ["acceptance"];
		const v = endoAttemptEvidenceV0({
			report: r,
			task: {
				status: "done",
				history: [
					{ atMs: 1, from: null, to: "open", note: null },
					{ atMs: 2, from: "open", to: "done", note: "first" },
					{ atMs: 3, from: "done", to: "open", note: null },
					{ atMs: 4, from: "open", to: "done", note: "second" },
				],
			},
			receipts: [],
			receiptProblems: 0,
			comparedWith: WT,
			current: null,
			readAtMs: 1,
		});
		expect(v.gaps.map((g) => g.code)).toEqual(["task-words-changed", "no-check"]);
		expect(v.operator.movedToDone).toEqual({ atMs: 4, note: "second" });
	});

	it("the terminal text labels every line with its source, exactly", () => {
		const r = report({});
		(r as { handoff: unknown }).handoff = { recordedAtMs: 1, target: "Pi", note: null };
		(r as { outcome: unknown }).outcome = { recordedAtMs: 2, kind: "reported", note: "all tests pass" };
		const v = endoAttemptEvidenceV0({
			report: r,
			task: { status: "review", history: history("open", "review") },
			receipts: [receipt(A, 3, AUTH_AT - 50), receipt(B, 0, AUTH_AT + 1)].map((x) => ({
				receipt: x,
				relation: x.revision.commit === B ? ("at-head" as const) : ("head-differs" as const),
			})),
			receiptProblems: 0,
			comparedWith: WT,
			current: { worktree: WT, commonDir: COMMON, commit: B, clean: true },
			readAtMs: 1,
		});
		const text = renderEndoAttemptEvidenceV0(v).split("\n");
		expect(text.slice(0, 10)).toEqual([
			"attempt endo.attempt.0123456789abcdef0123456789abcdef (task endo.task.t): Fix slugify",
			"  handoff   [operator] said they handed it to Pi",
			"  outcome   [operator] recorded as reported, not verified: all tests pass",
			"  sent      [observed] Sent to Pi, and Pi acknowledged it. That is a reply, not completion.",
			"  run       [Pi's report] Pi reported the run completed. Not verified.",
			`  candidate [none] no record names one; checked at: ${"a".repeat(12)}, ${"b".repeat(12)}`,
			`  tree now  [observed] ${"b".repeat(12)}, clean (/work/project)`,
			`  check     [observed; linked to this attempt by the operator] node --test: Observed check passed at ${"b".repeat(12)}; Recorded at this working tree's current HEAD`,
			"  decision  [operator] status review",
			"  gap       The task's status is not done: the operator has not recorded accepting it.",
		]);
		expect(text).toContain("  not established by any record:");
		const unsent = renderEndoAttemptEvidenceV0(read({ execution: null }).view);
		expect(unsent).toContain(
			"  run       [none] No run is attributed: no send through the workbench was authorised.",
		);
		const early = renderEndoAttemptEvidenceV0(read({ receipts: [receipt(B, 0, AUTH_AT - 50)] }).view);
		expect(early).toContain("; ended before the send was authorised");
		expect(early).not.toMatch(/verified\]|\[verified/);
	});

	it("the operator's decision is read as recorded, independent of Pi's report and the checks", () => {
		// Done while Pi's run failed and the only check failed: shown as both facts, neither corrected.
		const { view, gaps } = read({
			execution: { run: "failed" },
			receipts: [receipt(B, 3, AUTH_AT + 1)],
			status: "done",
		});
		expect(view.operator.status).toBe("done");
		expect(gaps).toEqual(["run-not-completed", "check-not-passed-at-current-head"]);
		// Not done while everything passed: still not accepted.
		expect(read({ receipts: [receipt(B, 0, AUTH_AT + 1)], status: "review" }).gaps).toEqual(["not-accepted"]);
		expect(read({ status: null }).gaps).toContain("task-unavailable");
	});
});
