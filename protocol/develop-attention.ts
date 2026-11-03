// DEVELOP attention (docs/designs/develop-attention.md): the evidence behind "what deserves my attention, and why?", across one project. A
// read-only PROJECTION of records that already exist (the task file, the attempt records, the verification receipts), computed at the read
// and never stored: there is no second source of truth and no status database. It decides nothing: which task needs attention is the page's
// deterministic classification (studio-ui/src/model/attention.ts) of the operator's own statuses and these observed facts.
//
// What it carries per task that is not done: how many attempts it has and the state of the newest, and for each distinct command ever
// checked on it, the LATEST receipt of that command (by start time), related to the launch directory's HEAD observed once for the whole
// read. "Latest" is per command: a later pass of `npm run lint` never hides an earlier failure of `npm test`, and an older pass never hides a
// newer failure of the same command. What could not be read is counted, never dropped silently.

import type { EndoDevelopAttemptStateV0 } from "./develop-attempts.ts";
import type {
	EndoReceiptExecutionV0,
	EndoReceiptOutcomeV0,
	EndoReceiptReasonV0,
	EndoReceiptRelationV0,
} from "./develop-receipts.ts";

export const ENDO_DEVELOP_ATTENTION_VIEW_SCHEMA_V0 = "endo.develop-attention-view.v0";

/**
 * Closed bounds on one read. `maxReceiptFiles`: receipt files (usable or not) read in all, across the project; once reached, the attempts
 * not yet read are counted as `skipped` and the view is `truncated`. `maxChecksPerTask`: distinct commands listed per task (the ones whose
 * latest receipt did not pass first); the rest are counted. `maxCommandChars`: a command as shown, cut.
 */
export const ENDO_DEVELOP_ATTENTION_LIMITS_V0 = Object.freeze({
	maxReceiptFiles: 2000,
	maxChecksPerTask: 5,
	maxCommandChars: 160,
});

/** The latest receipt of one command on one task, and how many older receipts of that same command there are, by outcome. */
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
	earlier: { passed: number; failed: number; inconclusive: number };
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
	checks: EndoDevelopAttentionCheckV0[];
	/** Further commands not listed, and how many of those did not pass. */
	more: { commands: number; notPassing: number };
}

/**
 * `GET workspace/attention`. `state`: `ready`; `unreadable` (the task file or the attempt records cannot be read: nothing is said about any
 * task's evidence); `unknown-project` (the launch's project is not in the file). `taskRevision` is the task file's revision this was read
 * at. `head` is the launch directory's HEAD as observed for this read, or null (then every relation is `unavailable`). `tasks`: every task of
 * the project that is not done, in file order; a done task's receipts are not read. No path, no session, no argv beyond the shown command.
 */
export interface EndoDevelopAttentionViewV0 {
	schemaVersion: typeof ENDO_DEVELOP_ATTENTION_VIEW_SCHEMA_V0;
	launchId: string;
	state: "ready" | "unreadable" | "unknown-project";
	taskRevision: number;
	head: { commit: string; clean: boolean } | null;
	tasks: EndoDevelopAttentionTaskV0[];
	truncated: boolean;
}
