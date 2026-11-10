// DEVELOP attention (docs/designs/develop-attention.md): the evidence behind "what deserves my attention, and why?", across one project. A
// read-only PROJECTION of records that already exist (the task file, the attempt records, the verification receipts), computed at the read
// and never stored: there is no second source of truth and no status database. It decides nothing: which task needs attention is the page's
// deterministic classification (studio-ui/src/model/attention.ts) of the operator's own statuses and these observed facts.
//
// What it carries per task that is not done: how many attempts it has and the state of the newest, and for each distinct command ever
// checked on it, the LATEST receipt of that command in each working tree (by start time, a receipt at the current HEAD first), related to
// the launch directory's HEAD observed once for the whole read. "Latest" is per check: a later pass of `npm run lint` never hides a failure
// of `npm test`, a pass in another worktree never hides one here, and a pass at an older commit never hides a failure at HEAD. What could not be read is counted, never dropped silently.
//
// v1 (DEVELOP-ATTENTION-002): an attempt with a verification plan is read by ITS OWN acceptance ledger (endoAcceptanceLedgerV0, the same
// function the Task view and `endo attempt evidence` use), never by exit status: a planned behavioural check that exits 0 with the wrong
// output is failed, one that exits with its declared non-zero code is passed, and disagreeing results at HEAD are `mixed`. Those receipts
// are listed under `planned`, one entry per planned check of that attempt; `checks` keeps v0's meaning for every other receipt (an attempt
// without a plan, or a command its plan does not name). A plan belongs to its attempt: two attempts that run the same argv are read
// separately, each by its own plan. The overview is triage; neither list is acceptance.

import type { EndoDevelopAttemptStateV0 } from "./develop-attempts.ts";
import type {
	EndoReceiptExecutionV0,
	EndoReceiptOutcomeV0,
	EndoReceiptReasonV0,
	EndoReceiptRelationV0,
} from "./develop-receipts.ts";
import type { EndoPlannedCheckStateV0 } from "./develop-verification.ts";

/** v0 is no longer served: it read every receipt by exit status, including a planned behavioural check's. */
export const ENDO_DEVELOP_ATTENTION_VIEW_SCHEMA_V1 = "endo.develop-attention-view.v1";

/**
 * Closed bounds on one read. `maxReceiptFiles` and `maxReceiptBytes`: receipt files (usable or not) read in all, across the project; once reached, the attempts
 * not yet read are counted as `skipped` and the view is `truncated`. `maxChecksPerTask`: distinct commands listed per task (failed first,
 * then inconclusive, then passed); the rest are counted. `maxCommandChars`: a command as shown, cut.
 */
export const ENDO_DEVELOP_ATTENTION_LIMITS_V0 = Object.freeze({
	maxReceiptFiles: 1000,
	/** The receipt bytes read in all (by the files' sizes before they are read): a receipt is a few KiB, its bound 128 KiB (one with kept output can be about 50 KiB). */
	maxReceiptBytes: 8 * 1024 * 1024,
	maxChecksPerTask: 5,
	/** Planned checks listed per task (failed first, then inconclusive or mixed, then without a current result, then passed); the rest are counted. */
	maxPlannedPerTask: 8,
	maxCommandChars: 160,
});

/**
 * The latest receipt of one check on one task (one argv, in one working tree of one repository; a receipt at the current HEAD outranks
 * any at another commit), and how many other receipts of that same check there are, by outcome.
 */
export interface EndoDevelopAttentionCheckV0 {
	/** The argv joined with spaces, display-safe and cut (the receipt keeps it exactly). Two commands are the same only when their argv are equal. */
	command: string;
	attemptId: string;
	receiptId: string;
	commit: string;
	startedAtMs: number;
	endedAtMs: number;
	outcome: EndoReceiptOutcomeV0;
	execution: EndoReceiptExecutionV0;
	reasons: EndoReceiptReasonV0[];
	/** Against the launch directory's HEAD observed for this read (`unavailable` when it could not be). */
	relation: EndoReceiptRelationV0;
	others: { passed: number; failed: number; inconclusive: number };
}

/**
 * One planned check of one attempt, as that attempt's acceptance ledger reads it (protocol/develop-verification.ts). `state` is the ledger's
 * own. `receipt` is the run behind it, with `outcome` as the PLAN reads it (behaviour for a behavioural check), not its exit status:
 * - passed, failed, inconclusive, mixed, tree-changed: the latest run at the current HEAD;
 * - stale: the latest run in this working tree, at another commit;
 * - elsewhere: the latest run in another working tree or repository; unavailable (HEAD not read): the latest run anywhere;
 * - not-run: none.
 * `incomplete`: some of this attempt's receipt files could not be used, so a later result may be among them. `behavioural`: the plan
 * declares an expected exit code and output for it.
 */
export interface EndoDevelopAttentionPlannedV1 {
	attemptId: string;
	name: string;
	/** The planned argv joined with spaces, display-safe and cut. */
	command: string;
	behavioural: boolean;
	state: EndoPlannedCheckStateV0;
	atHead: { passed: number; failed: number; inconclusive: number };
	receipt: {
		receiptId: string;
		commit: string;
		startedAtMs: number;
		endedAtMs: number;
		outcome: EndoReceiptOutcomeV0;
	} | null;
	incomplete: boolean;
}

/**
 * The overview's one triage rule for a planned check (the page mirrors it; a contract test holds them equal):
 * - `failed` | `inconclusive`: the ledger says so at HEAD (`mixed` is inconclusive); or there is no current result (tree changed,
 *   stale, elsewhere, HEAD not read) and the latest run behind it failed, was inconclusive, or the runs at HEAD disagree. A recorded
 *   failure is never dropped because the tree, the commit or the worktree moved on, nor because HEAD could not be read.
 * - `unsettled`: no current result otherwise (including never run), or a pass whose attempt has receipt files that could not be read.
 * - `passed`: passed at the current clean HEAD, every receipt file of its attempt read.
 */
export function endoPlannedTriageV1(
	p: EndoDevelopAttentionPlannedV1,
): "failed" | "inconclusive" | "unsettled" | "passed" {
	if (p.state === "failed") return "failed";
	if (p.state === "inconclusive" || p.state === "mixed") return "inconclusive";
	if (p.state === "passed") return p.incomplete ? "unsettled" : "passed";
	if (p.state === "not-run") return "unsettled";
	const reading = p.receipt?.outcome ?? null;
	const disagree = [p.atHead.passed, p.atHead.failed, p.atHead.inconclusive].filter((n) => n > 0).length >= 2;
	if (reading === "failed") return "failed";
	if (reading === "inconclusive" || disagree) return "inconclusive";
	return "unsettled";
}

export interface EndoDevelopAttentionTaskV0 {
	taskId: string;
	attempts: number;
	/** The most recently prepared attempt and its derived state (the operator's records; nothing here says anyone worked on it). */
	latestAttempt: { id: string; state: EndoDevelopAttemptStateV0; preparedAtMs: number } | null;
	/** Attempts whose receipt directory could not be read. */
	unreadable: number;
	/** Attempts whose receipts were not read because the read's limit was reached. */
	skipped: number;
	/** Files among its receipts that are not usable receipts. */
	problems: number;
	/** Its attempts' own record files (a handoff, an outcome) that are not usable: the latest attempt's state may be wrong. */
	records: number;
	/** Receipts no plan reads (an attempt without a plan, or a command its plan does not name), by exit status as in v0. */
	checks: EndoDevelopAttentionCheckV0[];
	/**
	 * Planned checks of this task's attempts that have a plan and whose receipts were read: every check of the newest attempt; of an older
	 * attempt, only the checks it ran, and only for a command no newer attempt has run (v0's "the latest run of a command" rule). An
	 * attempt whose receipts could not be read is in `unreadable` or `skipped`, never here. Listed by triage, worst first.
	 */
	planned: EndoDevelopAttentionPlannedV1[];
	/** Further planned checks not listed: how many, how many triage as failed or inconclusive, and how many as unsettled (endoPlannedTriageV1). */
	morePlanned: { checks: number; notPassing: number; notCurrent: number };
	/**
	 * Further commands not listed: how many, how many of those did not pass, and how many passed but not at the current clean HEAD (so a
	 * review can still say "Recheck" when the limit cut one).
	 */
	more: { commands: number; notPassing: number; notCurrent: number };
}

/**
 * `GET workspace/attention`. `state`: `ready`; `unreadable` (the task file or the attempt records cannot be read: nothing is said about any
 * task's evidence); `unknown-project` (the launch's project is not in the file). `taskRevision` is the task file's revision this was read
 * at. `head` is the launch directory's HEAD as observed for this read, or null (then every relation is `unavailable`). `tasks`: every task of
 * the project that is not done, in file order; a done task's receipts are not read. No path, no session, no argv beyond the shown command.
 */
export interface EndoDevelopAttentionViewV0 {
	schemaVersion: typeof ENDO_DEVELOP_ATTENTION_VIEW_SCHEMA_V1;
	launchId: string;
	state: "ready" | "unreadable" | "unknown-project";
	taskRevision: number;
	head: { commit: string; clean: boolean } | null;
	tasks: EndoDevelopAttentionTaskV0[];
	truncated: boolean;
	/**
	 * Files in the attempt records that are not usable and name no attempt this read could place (a damaged prepared record, an orphan, an
	 * unknown file): any task's attempts and checks may be incomplete, since which task such a file belonged to cannot be known.
	 */
	unattributed: number;
}
