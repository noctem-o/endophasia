// The DEVELOP attention projection (protocol/develop-attention.ts, docs/designs/develop-attention.md): one project's evidence, summarised
// for triage, from the stores that hold it. Read-only: this module calls only `read()` on the task, attempt and receipt stores, and is
// given the launch directory's HEAD by its caller (observed ONCE per read, by the same read-only observer the attempts view uses). It
// writes nothing, runs nothing, and changes no task, attempt, receipt, session or permission.
//
// Bounded: done tasks' receipts are not read; receipt files read in all are capped (ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxReceiptFiles), and
// an attempt directory larger than what is left is not read at all (its attempt is `skipped`, the view `truncated`). The order receipts are
// read in is fixed (review, in progress, blocked, open; newest attempt first), so a limit falls on the same attempts every time.

import { endoDevelopAttemptStateV0 } from "../../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_ATTENTION_LIMITS_V0,
	ENDO_DEVELOP_ATTENTION_VIEW_SCHEMA_V0,
	type EndoDevelopAttentionCheckV0,
	type EndoDevelopAttentionTaskV0,
	type EndoDevelopAttentionViewV0,
} from "../../protocol/develop-attention.ts";
import {
	type EndoDevelopReceiptV0,
	type EndoReceiptCurrentV0,
	endoReceiptRelationV0,
} from "../../protocol/develop-receipts.ts";
import type { EndoDevelopTaskStatusV0 } from "../../protocol/develop-tasks.ts";
import type { DevelopAttemptsStoreV0 } from "../../storage/develop-attempts.ts";
import type { DevelopReceiptsStoreV0 } from "../../storage/develop-receipts.ts";
import type { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { endoShownTextV0 } from "./develop-attempts.ts";

/** The order receipts are read in, so a limit always falls on the least pressing tasks first. Done tasks are not read. */
const READ_ORDER: Readonly<Record<Exclude<EndoDevelopTaskStatusV0, "done">, number>> = {
	review: 0,
	"in-progress": 1,
	blocked: 2,
	open: 3,
};

/**
 * Later is greater: by start time, then end time, then id (a fixed order for receipts that started in the same millisecond). Shared with the
 * acceptance ledger (develop-verification.ts), so "the latest receipt of a check" means one thing everywhere.
 */
export const endoReceiptLaterV0 = (
	a: Pick<EndoDevelopReceiptV0, "startedAtMs" | "endedAtMs" | "id">,
	b: Pick<EndoDevelopReceiptV0, "startedAtMs" | "endedAtMs" | "id">,
): boolean =>
	a.startedAtMs !== b.startedAtMs
		? a.startedAtMs > b.startedAtMs
		: a.endedAtMs !== b.endedAtMs
			? a.endedAtMs > b.endedAtMs
			: a.id > b.id;

/**
 * The latest receipt of each distinct check, with the other receipts of that check counted. A check is one argv run in one working tree
 * of one repository: a pass in another worktree or clone is a different check, and never stands for this one. Within a check, a receipt
 * at the current HEAD outranks every receipt at another commit, however recent: a pass recorded later at an older commit (a bisect, an
 * old checkout) never hides a failure at HEAD.
 */
export function endoLatestChecksV0(
	receipts: readonly EndoDevelopReceiptV0[],
	current: EndoReceiptCurrentV0 | null,
): EndoDevelopAttentionCheckV0[] {
	const groups = new Map<string, EndoDevelopReceiptV0[]>();
	for (const r of receipts) {
		const key = JSON.stringify([r.check.argv, r.repository.commonDir, r.repository.worktree]);
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	const checks: EndoDevelopAttentionCheckV0[] = [];
	for (const group of groups.values()) {
		const atHead = group.filter((r) => {
			const relation = endoReceiptRelationV0(r, current);
			return relation === "at-head" || relation === "at-head-changed";
		});
		const pool = atHead.length > 0 ? atHead : group;
		let latest = pool[0] as EndoDevelopReceiptV0;
		for (const r of pool) if (endoReceiptLaterV0(r, latest)) latest = r;
		const others = { passed: 0, failed: 0, inconclusive: 0 };
		for (const r of group) if (r !== latest) others[r.outcome] += 1;
		checks.push({
			command: endoShownTextV0(latest.check.argv.join(" "), ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxCommandChars),
			attemptId: latest.attemptId,
			receiptId: latest.id,
			commit: latest.revision.commit,
			startedAtMs: latest.startedAtMs,
			endedAtMs: latest.endedAtMs,
			outcome: latest.outcome,
			execution: latest.execution,
			reasons: [...latest.reasons],
			relation: endoReceiptRelationV0(latest, current),
			others,
		});
	}
	// The attention precedence, so the per-task limit always cuts the least telling checks first: failed, inconclusive, a pass that is not at
	// the current clean HEAD (a review waits on rechecking it), then a current pass; then the most recent; the receipt id last, so the
	// order is total.
	const rank = (c: EndoDevelopAttentionCheckV0): number =>
		c.outcome === "failed" ? 0 : c.outcome === "inconclusive" ? 1 : c.relation === "at-head" ? 3 : 2;
	return checks.sort(
		(a, b) =>
			rank(a) - rank(b) ||
			b.startedAtMs - a.startedAtMs ||
			(a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0),
	);
}

export interface DevelopAttentionSourcesV0 {
	tasks: DevelopTasksStoreV0;
	attempts: DevelopAttemptsStoreV0;
	receipts: DevelopReceiptsStoreV0 | null;
}

/**
 * One project's attention view, read now. `current` is the launch directory's HEAD, observed by the caller for this read (null: not
 * observed, and every relation is `unavailable`). `limits` is for tests.
 */
export function endoDevelopAttentionViewV0(
	sources: DevelopAttentionSourcesV0,
	scope: { projectId: string; launchId: string },
	current: EndoReceiptCurrentV0 | null,
	limits: { maxReceiptFiles: number; maxReceiptBytes: number } = ENDO_DEVELOP_ATTENTION_LIMITS_V0,
): EndoDevelopAttentionViewV0 {
	const base = {
		schemaVersion: ENDO_DEVELOP_ATTENTION_VIEW_SCHEMA_V0,
		launchId: scope.launchId,
		head: current === null ? null : { commit: current.commit, clean: current.clean },
		tasks: [],
		truncated: false,
		unattributed: 0,
	} as const;
	const file = sources.tasks.read();
	if (!file.ok) return { ...base, state: "unreadable", taskRevision: 0, tasks: [] };
	const taskRevision = file.file.revision;
	if (!file.file.projects.some((p) => p.id === scope.projectId))
		return { ...base, state: "unknown-project", taskRevision, tasks: [] };
	const read = sources.attempts.read();
	if (!read.ok) return { ...base, state: "unreadable", taskRevision, tasks: [] };

	const open = file.file.tasks.filter((t) => t.projectId === scope.projectId && t.status !== "done");
	const views = new Map<string, EndoDevelopAttentionTaskV0>();
	const byTask = new Map<string, typeof read.entries>();
	for (const e of read.entries) {
		if (e.attempt.projectId !== scope.projectId) continue;
		byTask.set(e.attempt.taskId, [...(byTask.get(e.attempt.taskId) ?? []), e]);
	}
	// A damaged attempt record is a problem of the attempts directory, not a failure of the read: those naming an attempt that was read are
	// counted on its task; the rest cannot be placed, and are counted for the whole read (never dropped).
	const owner = new Map(read.entries.map((e) => [e.attempt.id, e.attempt] as const));
	const records = new Map<string, number>();
	let unattributed = 0;
	for (const problem of read.problems) {
		const attempt = owner.get(problem.name.split(".").slice(0, 3).join("."));
		if (attempt === undefined) unattributed += 1;
		else if (attempt.projectId === scope.projectId)
			records.set(attempt.taskId, (records.get(attempt.taskId) ?? 0) + 1);
	}
	let left = limits.maxReceiptFiles;
	let leftBytes = limits.maxReceiptBytes;
	let truncated = false;
	const order = open
		.map((task, at) => ({ task, at }))
		.sort(
			(a, b) =>
				READ_ORDER[a.task.status as Exclude<EndoDevelopTaskStatusV0, "done">] -
					READ_ORDER[b.task.status as Exclude<EndoDevelopTaskStatusV0, "done">] || a.at - b.at,
		);
	for (const { task } of order) {
		// Newest attempt first (by preparation time, then id).
		const entries = [...(byTask.get(task.id) ?? [])].sort(
			(a, b) =>
				b.attempt.preparedAtMs - a.attempt.preparedAtMs ||
				(a.attempt.id < b.attempt.id ? 1 : a.attempt.id > b.attempt.id ? -1 : 0),
		);
		const newest = entries[0];
		let unreadable = 0;
		let skipped = 0;
		let problems = 0;
		const receipts: EndoDevelopReceiptV0[] = [];
		if (sources.receipts !== null)
			for (const e of entries) {
				if (truncated) {
					skipped += 1;
					continue;
				}
				const got = sources.receipts.readAtMost(e.attempt.id, { files: left, bytes: leftBytes });
				if (!got.ok) {
					if (got.reason === "too-many") {
						truncated = true;
						skipped += 1;
					} else unreadable += 1;
					continue;
				}
				left -= got.receipts.length + got.problems.length;
				leftBytes -= got.bytes ?? 0;
				problems += got.problems.length;
				receipts.push(...got.receipts);
			}
		const checks = endoLatestChecksV0(receipts, current);
		const shown = checks.slice(0, ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxChecksPerTask);
		const rest = checks.slice(ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxChecksPerTask);
		views.set(task.id, {
			taskId: task.id,
			attempts: entries.length,
			latestAttempt:
				newest === undefined
					? null
					: {
							id: newest.attempt.id,
							state: endoDevelopAttemptStateV0(newest.handoff, newest.outcome),
							preparedAtMs: newest.attempt.preparedAtMs,
						},
			unreadable,
			skipped,
			problems,
			records: records.get(task.id) ?? 0,
			checks: shown,
			more: {
				commands: rest.length,
				notPassing: rest.filter((c) => c.outcome !== "passed").length,
				notCurrent: rest.filter((c) => c.outcome === "passed" && c.relation !== "at-head").length,
			},
		});
	}
	return {
		...base,
		state: "ready",
		taskRevision,
		// In the task file's order, whatever order they were read in.
		tasks: open.map((t) => views.get(t.id) as EndoDevelopAttentionTaskV0),
		truncated,
		unattributed,
	};
}
