// A project as an operator might have it after a few weeks: a dozen tasks in every status, attempts on several of them, and checks that
// passed, failed, timed out, went stale against a later commit or were run in another working tree. Synthetic text only. Written through the
// real stores (the CLI's own path), so the workbench reads exactly what `endo task`, `endo attempt` and `endo attempt check` would have left.
import {
	type EndoDevelopReceiptV0,
	type EndoReceiptCurrentV0,
	type EndoReceiptFactsV0,
	endoReceiptVerdictV0,
} from "../protocol/develop-receipts.ts";
import type { EndoDevelopTaskStatusV0 } from "../protocol/develop-tasks.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";

let serial = 0;

/** A receipt as `endo attempt check` would have written it, observed at `current`, with the facts given. */
export function receiptAt(
	current: EndoReceiptCurrentV0,
	attemptId: string,
	projectId: string,
	startedAtMs: number,
	change: Partial<EndoReceiptFactsV0> = {},
): EndoDevelopReceiptV0 {
	serial += 1;
	const commit = change.revision?.commit ?? current.commit;
	const facts: EndoReceiptFactsV0 = {
		repository: { worktree: current.worktree, commonDir: current.commonDir, linked: false },
		revision: { commit, tree: "e".repeat(40), branch: "refs/heads/main" },
		reflog: "compared",
		check: {
			argv: ["npm", "test"],
			executable: "/usr/bin/npm",
			realExecutable: "/usr/lib/npm/bin/npm-cli.js",
			timeoutMs: 600_000,
		},
		execution: { kind: "exited", code: 0 },
		strayProcesses: false,
		escapedProcess: false,
		after: {
			state: "observed",
			sameRepository: true,
			commit,
			tree: "e".repeat(40),
			clean: true,
			reflogsUnchanged: true,
			rulesUnchanged: true,
		},
		...change,
	};
	return {
		schemaVersion: "endo.develop-receipt.v0",
		id: `endo.receipt.${serial.toString(16).padStart(32, "0")}`,
		attemptId,
		projectId,
		requestedBy: "operator",
		via: "cli",
		observer: { tool: "endo", version: "0.0.0-test" },
		startedAtMs,
		endedAtMs: startedAtMs + 42_000,
		durationMs: 42_000,
		...facts,
		output: { stdoutBytes: 2048, stderrBytes: 12 },
		...endoReceiptVerdictV0(facts),
	};
}

const PATH: Readonly<Record<EndoDevelopTaskStatusV0, readonly EndoDevelopTaskStatusV0[]>> = {
	open: [],
	"in-progress": ["in-progress"],
	blocked: ["in-progress", "blocked"],
	review: ["in-progress", "review"],
	done: ["in-progress", "review", "done"],
};

/** Create a task and walk it to `status` through the moves the store allows, each with the operator's note. */
export function taskIn(
	root: string,
	projectId: string,
	title: string,
	status: EndoDevelopTaskStatusV0,
	note: string | null = null,
	acceptance = "",
): string {
	const store = new DevelopTasksStoreV0(root);
	const made = store.createTask(projectId, { title, acceptance });
	if (!made.ok) throw new Error(`create refused: ${made.code}`);
	let task = made.value;
	const path = PATH[status];
	for (const [i, to] of path.entries()) {
		const moved = store.setStatus(projectId, task.id, task.revision, to, i === path.length - 1 ? (note ?? "") : "");
		if (!moved.ok) throw new Error(`status refused: ${moved.code}`);
		task = moved.value;
	}
	return task.id;
}

export interface SeededAttention {
	tasks: Record<string, string>;
	attempts: Record<string, string>;
}

/**
 * The fixture project. Times are fixed (a November 2026 afternoon), so the order is the same on every run. What each task is for:
 *   review, no checks        a decision with no evidence: shown for the decision, never as a failure
 *   review, stale pass       a decision whose evidence belongs to an earlier commit
 *   fail then pass           resolved: the later pass of the same command is the latest
 *   pass then fail           the later failure is the latest, whatever passed before
 *   timed out                inconclusive
 *   other worktree           a check from another working tree: not compared
 *   blocked                  the operator's own status, with their note
 *   done with an old failure finished work is never urgent
 */
export function seedAttention(root: string, projectId: string, current: EndoReceiptCurrentV0): SeededAttention {
	const t0 = Date.UTC(2026, 10, 3, 13, 0);
	const minutes = (n: number) => t0 + n * 60_000;
	const tasks: Record<string, string> = {
		decide: taskIn(root, projectId, "Stream the parser", "review", "ready: parseStream yields per chunk"),
		stale: taskIn(root, projectId, "Error recovery after a bad token", "review", "agent says it is done"),
		resolved: taskIn(root, projectId, "Accept trailing commas", "in-progress"),
		regressed: taskIn(root, projectId, "Normalize CRLF line endings", "in-progress"),
		timeout: taskIn(root, projectId, "Unicode identifiers", "in-progress"),
		elsewhere: taskIn(root, projectId, "Source maps for tokens", "in-progress"),
		blocked: taskIn(root, projectId, "Benchmark the streaming path", "blocked", "waiting on the CI runner image"),
		refactor: taskIn(root, projectId, "Refactor AST node types", "review"),
		docs: taskIn(root, projectId, "Document the streaming API", "open"),
		lint: taskIn(root, projectId, "Tighten the lint configuration", "open"),
		legacy: taskIn(root, projectId, "Remove the legacy tokenizer", "done", "merged"),
		bom: taskIn(root, projectId, "Handle a byte-order mark", "done"),
	};
	const service = new DevelopAttemptsServiceV0(new DevelopTasksStoreV0(root), new DevelopAttemptsStoreV0(root));
	const receipts = new DevelopReceiptsStoreV0(root);
	const attempts: Record<string, string> = {};
	const prepare = (key: string, objective: string, handoff?: string, verification?: unknown) => {
		const made = service.prepare(projectId, tasks[key]!, {
			objective,
			...(verification === undefined ? {} : { verification }),
		});
		if (!made.ok) throw new Error(`prepare refused: ${made.code}`);
		attempts[key] = made.value.id;
		if (handoff !== undefined && !service.handoff(made.value.id, { target: handoff }).ok) throw new Error("handoff");
		return made.value.id;
	};
	const write = (key: string, at: number, change: Partial<EndoReceiptFactsV0> = {}) => {
		const made = receipts.write(receiptAt(current, attempts[key]!, projectId, at, change));
		if (made !== "created") throw new Error(`receipt refused: ${made}`);
	};
	const earlier = "f".repeat(40);
	const stale = {
		revision: { commit: earlier, tree: "e".repeat(40), branch: "refs/heads/main" },
		after: {
			state: "observed" as const,
			sameRepository: true,
			commit: earlier,
			tree: "e".repeat(40),
			clean: true,
			reflogsUnchanged: true,
			rulesUnchanged: true,
		},
	};
	const lint = {
		argv: ["npm", "run", "lint"],
		executable: "/usr/bin/npm",
		realExecutable: "/usr/lib/npm/bin/npm-cli.js",
		timeoutMs: 600_000,
	};

	prepare("decide", "Make parseStream yield tokens as chunks arrive.", "Claude Code");
	if (!service.report(attempts.decide!, "The agent says the streaming tests pass.").ok) throw new Error("report");

	prepare("stale", "Recover after a bad token instead of throwing.", "Codex");
	write("stale", minutes(5), stale);

	prepare("resolved", "Accept a trailing comma in argument lists.", "Claude Code");
	write("resolved", minutes(10), { execution: { kind: "exited", code: 1 } });
	write("resolved", minutes(20));

	// With a verification plan, so its receipts sit inside the attempt's own "every check recorded" disclosure: opening a receipt from the
	// overview must open that too (Codex, #139).
	prepare("regressed", "Treat CRLF as one line ending everywhere.", "Claude Code", {
		checks: [
			{ name: "unit", argv: ["npm", "test"], shows: "the unit tests pass" },
			{ name: "lint", argv: ["npm", "run", "lint"], shows: "the linter reports nothing" },
		],
		criteria: [{ text: "CRLF is one line ending, tested and lint-clean", checks: ["unit", "lint"] }],
	});
	write("regressed", minutes(30));
	write("regressed", minutes(31), { check: lint });
	write("regressed", minutes(40), { execution: { kind: "exited", code: 1 } });

	prepare("timeout", "Allow Unicode letters in identifiers.");
	write("timeout", minutes(50), { execution: { kind: "timed-out" } });

	prepare("elsewhere", "Attach a source position to every token.", "Codex");
	write("elsewhere", minutes(55), {
		repository: { worktree: "/work/parser-sourcemaps", commonDir: current.commonDir, linked: true },
	});

	prepare("legacy", "Delete the old tokenizer and its tests.");
	write("legacy", minutes(2), { execution: { kind: "exited", code: 2 } });

	return { tasks, attempts };
}
