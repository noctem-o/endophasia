// Browser wire gate for the attention projection (`GET workspace/attention`, protocol/develop-attention.ts, served read-only by
// runtime/contracts/workspace-routes.ts). It checks that a body has exactly the shape the overview reads, that every check's outcome is the one its
// execution and reasons imply (as the attempts gate does), that a relation can be what the view says of HEAD (no "at-head" when HEAD was not
// observed), and refuses the body whole otherwise. There is no request body or query: the page names no project, task or path.
// v1 adds `planned`: an attempt with a plan, read by its own ledger. Each entry's state must be one its receipt and the observed HEAD allow
// (a pass, failure or disagreement at a clean HEAD names a receipt at that commit; a stale one names a receipt elsewhere; not run names
// none), or the body is refused.
import type { EndoDevelopAttentionPlannedV1, EndoDevelopAttentionViewV0 } from "../../../protocol/develop-attention.ts";
import {
	ATTEMPT_STATES,
	attemptId,
	coherent,
	distinct,
	execution,
	keysOf,
	objectId,
	oneLine,
	PLANNED_CHECK_LABELS,
	RECEIPT_OUTCOME_LABELS,
	RECEIPT_REASON_TEXT,
	RECEIPT_RELATION_LABELS,
	receiptId,
	stamp,
	taskId,
} from "./attempts-wire.ts";
import { type Check, count, list, one, shape } from "./compare-wire.ts";

export type {
	EndoDevelopAttentionCheckV0 as AttentionCheck,
	EndoDevelopAttentionPlannedV1 as AttentionPlanned,
	EndoDevelopAttentionTaskV0 as AttentionTask,
	EndoDevelopAttentionViewV0 as AttentionView,
} from "../../../protocol/develop-attention.ts";

export const ATTENTION_SCHEMA = "endo.develop-attention-view.v1";
/** These mirror ENDO_DEVELOP_ATTENTION_LIMITS_V0 (protocol/develop-attention.ts); a contract test holds them equal. */
export const ATTENTION_LIMITS = { maxChecksPerTask: 5, maxPlannedPerTask: 8, maxCommandChars: 160 } as const;
/** The task file's own bound on tasks (protocol/develop-tasks.ts): the view cannot list more. */
const MAX_TASKS = 300;

const check: Check = (v) =>
	shape(v, {
		command: (x) => oneLine(ATTENTION_LIMITS.maxCommandChars)(x) && (x as string).length > 0,
		attemptId,
		receiptId,
		commit: objectId,
		startedAtMs: stamp,
		endedAtMs: stamp,
		outcome: one(...keysOf(RECEIPT_OUTCOME_LABELS)),
		execution,
		reasons: (x) => list(one(...keysOf(RECEIPT_REASON_TEXT)))(x) && distinct(x),
		relation: one(...keysOf(RECEIPT_RELATION_LABELS)),
		others: (x) => shape(x, { passed: count, failed: count, inconclusive: count }),
	});

const counts: Check = (x) => shape(x, { passed: count, failed: count, inconclusive: count });

const planned: Check = (v) =>
	shape(v, {
		attemptId,
		name: (x) => typeof x === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(x),
		command: (x) => oneLine(ATTENTION_LIMITS.maxCommandChars)(x) && (x as string).length > 0,
		behavioural: (x) => typeof x === "boolean",
		state: one(...keysOf(PLANNED_CHECK_LABELS)),
		atHead: counts,
		receipt: (x) =>
			x === null ||
			shape(x, {
				receiptId,
				commit: objectId,
				startedAtMs: stamp,
				endedAtMs: stamp,
				outcome: one(...keysOf(RECEIPT_OUTCOME_LABELS)),
			}),
		incomplete: (x) => typeof x === "boolean",
		elsewhere: (x) =>
			x === null ||
			shape(x, {
				receiptId,
				commit: objectId,
				startedAtMs: stamp,
				endedAtMs: stamp,
				outcome: one(...keysOf(RECEIPT_OUTCOME_LABELS)),
			}),
	});

/** Whether a planned entry's state is one its receipt, its counts and the observed HEAD allow (the ledger's own rules). */
function plannedCoherent(p: EndoDevelopAttentionPlannedV1, head: EndoDevelopAttentionViewV0["head"]): boolean {
	const total = p.atHead.passed + p.atHead.failed + p.atHead.inconclusive;
	const r = p.receipt;
	if (r !== null && r.endedAtMs < r.startedAtMs) return false;
	// A run elsewhere is named only beside a state decided in this tree, and never as the receipt itself.
	if (p.elsewhere !== null) {
		if (p.state === "elsewhere" || p.state === "unavailable" || head === null) return false;
		if (p.elsewhere.endedAtMs < p.elsewhere.startedAtMs || p.elsewhere.receiptId === r?.receiptId) return false;
	}
	// Without a HEAD nothing is compared; the latest run anywhere may still be named (a recorded failure stays visible).
	if (head === null) return p.state === "unavailable" && total === 0;
	const here = r !== null && r.commit === head.commit;
	switch (p.state) {
		case "unavailable":
			return false;
		case "passed":
		case "failed":
		case "inconclusive":
			return head.clean && here && r.outcome === p.state && p.atHead[p.state] === total && total > 0;
		case "mixed":
			return (
				head.clean &&
				here &&
				[p.atHead.passed, p.atHead.failed, p.atHead.inconclusive].filter((n) => n > 0).length >= 2
			);
		case "tree-changed":
			return !head.clean && here && total > 0;
		case "stale":
			return r !== null && r.commit !== head.commit && total === 0;
		case "elsewhere":
			// Its latest run in another working tree or repository, at any commit (or none named).
			return total === 0;
		case "not-run":
			return r === null && total === 0;
	}
}

const task: Check = (v) =>
	shape(v, {
		taskId,
		attempts: count,
		latestAttempt: (x) =>
			x === null || shape(x, { id: attemptId, state: one(...ATTEMPT_STATES), preparedAtMs: stamp }),
		unreadable: count,
		skipped: count,
		problems: count,
		records: count,
		checks: (x) => list(check)(x) && (x as unknown[]).length <= ATTENTION_LIMITS.maxChecksPerTask,
		planned: (x) => list(planned)(x) && (x as unknown[]).length <= ATTENTION_LIMITS.maxPlannedPerTask,
		morePlanned: (x) => shape(x, { checks: count, notPassing: count, notCurrent: count }),
		more: (x) => shape(x, { commands: count, notPassing: count, notCurrent: count }),
	});

export function readAttention(v: unknown): EndoDevelopAttentionViewV0 | null {
	if (
		!shape(v, {
			schemaVersion: one(ATTENTION_SCHEMA),
			launchId: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
			state: one("ready", "unreadable", "unknown-project"),
			taskRevision: count,
			head: (x) => x === null || shape(x, { commit: objectId, clean: (c) => typeof c === "boolean" }),
			tasks: (x) => list(task)(x) && (x as unknown[]).length <= MAX_TASKS,
			truncated: (x) => typeof x === "boolean",
			unattributed: count,
		})
	)
		return null;
	const view = v as unknown as EndoDevelopAttentionViewV0;
	if (view.state !== "ready" && (view.tasks.length > 0 || view.truncated || view.unattributed > 0)) return null;
	if (new Set(view.tasks.map((t) => t.taskId)).size !== view.tasks.length) return null;
	for (const t of view.tasks) {
		if ((t.attempts === 0) !== (t.latestAttempt === null)) return null;
		if (t.unreadable + t.skipped > t.attempts) return null;
		if (t.skipped > 0 && !view.truncated) return null;
		if (t.more.notPassing + t.more.notCurrent > t.more.commands) return null;
		if (t.more.commands > 0 && t.checks.length < ATTENTION_LIMITS.maxChecksPerTask) return null;
		if (new Set(t.checks.map((c) => c.receiptId)).size !== t.checks.length) return null;
		if (t.morePlanned.notPassing + t.morePlanned.notCurrent > t.morePlanned.checks) return null;
		if (t.morePlanned.checks > 0 && t.planned.length < ATTENTION_LIMITS.maxPlannedPerTask) return null;
		if (t.planned.length > 0 && t.attempts === 0) return null;
		if (new Set(t.planned.map((p) => `${p.attemptId} ${p.name}`)).size !== t.planned.length) return null;
		for (const p of t.planned) if (!plannedCoherent(p, view.head)) return null;
		for (const c of t.checks) {
			if (!coherent(c)) return null;
			// A relation is about the HEAD this read observed: without one, nothing can have been compared.
			if (view.head === null && c.relation !== "unavailable") return null;
			if (view.head !== null && c.relation === "unavailable") return null;
			if (view.head !== null && (c.relation === "at-head" || c.relation === "at-head-changed")) {
				if (c.commit !== view.head.commit) return null;
				if ((c.relation === "at-head") !== view.head.clean) return null;
			}
			if (c.relation === "head-differs" && view.head !== null && c.commit === view.head.commit) return null;
		}
	}
	return view;
}

export type AttentionReply =
	| { kind: "attention"; record: EndoDevelopAttentionViewV0 }
	| { kind: "absent" }
	| { kind: "failure"; status: number; code: "grant-required" | "invalid" | "unreachable" | "other" };
