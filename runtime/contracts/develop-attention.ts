// The DEVELOP attention projection (protocol/develop-attention.ts, docs/designs/develop-attention.md): one project's evidence, summarised
// for triage, from the stores that hold it. Read-only: this module calls only `read()` on the task, attempt and receipt stores, and is
// given the launch directory's HEAD by its caller (observed ONCE per read, by the same read-only observer the attempts view uses). It
// writes nothing, runs nothing, and changes no task, attempt, receipt, session or permission.
//
// Bounded: done tasks' receipts are not read; receipt files read in all are capped (ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxReceiptFiles), and
// an attempt directory larger than what is left is not read at all (its attempt is `skipped`, the view `truncated`). The order receipts are
// read in is fixed (review, in progress, blocked, open; newest attempt first), so a limit falls on the same attempts every time.
//
// v1: an attempt with a verification plan is read by its own acceptance ledger (endoAcceptanceLedgerV0, the function the Task view and the
// CLI evidence reading use): one entry per planned check, in the ledger's state. Only receipts no plan reads go through endoLatestChecksV0.

import { endoAttemptPlanV0, endoDevelopAttemptStateV0 } from "../../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_ATTENTION_LIMITS_V0,
	ENDO_DEVELOP_ATTENTION_VIEW_SCHEMA_V1,
	type EndoDevelopAttentionCheckV0,
	type EndoDevelopAttentionPlannedV1,
	type EndoDevelopAttentionTaskV0,
	type EndoDevelopAttentionViewV0,
	endoPlannedTriageV1,
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
import { endoAcceptanceLedgerV0, endoPlannedReadingV0 } from "./develop-verification.ts";

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

/** A planned check's triage rank (endoPlannedTriageV1): the per-task limit can only cut entries no more telling than those it lists. */
const TRIAGE_RANK = { failed: 0, inconclusive: 1, unsettled: 2, passed: 3 } as const;
const rankOf = (p: EndoDevelopAttentionPlannedV1): number => TRIAGE_RANK[endoPlannedTriageV1(p)];

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The planned checks of one attempt, as its own ledger reads them over its own receipts, each with its argv (to tell commands apart across
 * attempts). For a check without a current result whose ledger names no run in this working tree (elsewhere, or HEAD not read), the run
 * behind it is its latest anywhere, read by the same rule the ledger uses (endoPlannedReadingV0).
 */
function plannedOf(
	attemptId: string,
	plan: NonNullable<ReturnType<typeof endoAttemptPlanV0>>,
	receipts: readonly EndoDevelopReceiptV0[],
	current: EndoReceiptCurrentV0 | null,
	incomplete: boolean,
): { entry: EndoDevelopAttentionPlannedV1; argv: readonly string[] }[] {
	const ledger = endoAcceptanceLedgerV0({ plan, receipts, current });
	return ledger.checks.map((c, i) => {
		const planned = plan.checks[i] as (typeof plan.checks)[number];
		let behind: EndoDevelopAttentionPlannedV1["receipt"] = null;
		const named = c.current ?? c.otherCommit;
		if (named !== null)
			behind = {
				receiptId: named.receiptId,
				commit: named.commit,
				startedAtMs: named.startedAtMs,
				endedAtMs: named.endedAtMs,
				outcome: named.outcome,
			};
		else if (c.state === "elsewhere" || c.state === "unavailable") {
			let latest: EndoDevelopReceiptV0 | null = null;
			for (const r of receipts)
				if (sameArgv(r.check.argv, planned.argv) && (latest === null || endoReceiptLaterV0(r, latest))) latest = r;
			if (latest !== null)
				behind = {
					receiptId: latest.id,
					commit: latest.revision.commit,
					startedAtMs: latest.startedAtMs,
					endedAtMs: latest.endedAtMs,
					outcome: endoPlannedReadingV0(planned, latest),
				};
		}
		return {
			argv: planned.argv,
			entry: {
				attemptId,
				name: c.name,
				command: endoShownTextV0(planned.argv.join(" "), ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxCommandChars),
				behavioural: planned.expect !== undefined,
				state: c.state,
				atHead: { ...c.atHead },
				receipt: behind,
				incomplete,
			},
		};
	});
}

interface Candidate {
	entry: EndoDevelopAttentionPlannedV1;
	/** The planned argv, as JSON: the command, across attempts. */
	key: string;
	newest: boolean;
	/** The order read in: attempts newest first, then the plan's order. */
	order: number;
}

/** How current the run behind an entry is: a clean HEAD, then HEAD with a changed tree, then another commit here, then elsewhere. */
const CURRENCY: Readonly<Record<EndoDevelopAttentionPlannedV1["state"], number>> = {
	passed: 3,
	failed: 3,
	inconclusive: 3,
	mixed: 3,
	"tree-changed": 2,
	stale: 1,
	elsewhere: 0,
	unavailable: 0,
	"not-run": -1,
};

/**
 * Which planned entries a task lists. The newest attempt's are all listed. An older attempt's entry is listed only if it ran (an old plan's
 * unrun checks are history, not work) and no NEWER attempt has a LATER run of the same command that is at least as current (a clean HEAD,
 * then a changed tree, then another commit, then another worktree or no HEAD). That is v0's "the latest run of a command decides", without
 * ever letting an earlier run, a stale run or a run in another worktree hide a later or more current one.
 */
function supersede(candidates: readonly Candidate[]): EndoDevelopAttentionPlannedV1[] {
	const later = (
		a: NonNullable<EndoDevelopAttentionPlannedV1["receipt"]>,
		b: NonNullable<EndoDevelopAttentionPlannedV1["receipt"]>,
	) => endoReceiptLaterV0({ ...a, id: a.receiptId }, { ...b, id: b.receiptId });
	return candidates
		.filter((x) => {
			if (x.newest) return true;
			const r = x.entry.receipt;
			if (x.entry.state === "not-run" || r === null) return false;
			const attempt = x.entry.attemptId;
			return !candidates.some(
				(y) =>
					y.order < x.order &&
					y.entry.attemptId !== attempt &&
					y.key === x.key &&
					y.entry.receipt !== null &&
					later(y.entry.receipt, r) &&
					CURRENCY[y.entry.state] >= CURRENCY[x.entry.state],
			);
		})
		.map((x) => x.entry);
}

/** The triage order of planned checks: by triage, then the most recent run, then attempt and name (a total order). */
export function endoPlannedOrderV1(a: EndoDevelopAttentionPlannedV1, b: EndoDevelopAttentionPlannedV1): number {
	return (
		rankOf(a) - rankOf(b) ||
		(b.receipt?.startedAtMs ?? -1) - (a.receipt?.startedAtMs ?? -1) ||
		(a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0) ||
		(a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
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
		schemaVersion: ENDO_DEVELOP_ATTENTION_VIEW_SCHEMA_V1,
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
		// Every planned entry of every planned attempt read, newest attempt first; `supersede` picks what is listed.
		const candidates: Candidate[] = [];
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
				const plan = endoAttemptPlanV0(e.attempt);
				if (plan === null) {
					receipts.push(...got.receipts);
					continue;
				}
				// Its plan reads the receipts of the commands it names; any other receipt of it is read by exit status, as in v0. Which of its
				// entries are listed is decided once every attempt is read (supersede, below).
				for (const { entry, argv } of plannedOf(e.attempt.id, plan, got.receipts, current, got.problems.length > 0))
					candidates.push({ entry, key: JSON.stringify(argv), newest: e === newest, order: candidates.length });
				for (const r of got.receipts)
					if (!plan.checks.some((c) => sameArgv(c.argv, r.check.argv))) receipts.push(r);
			}
		const planned = supersede(candidates);
		planned.sort(endoPlannedOrderV1);
		const plannedShown = planned.slice(0, ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxPlannedPerTask);
		const plannedRest = planned.slice(ENDO_DEVELOP_ATTENTION_LIMITS_V0.maxPlannedPerTask);
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
			planned: plannedShown,
			morePlanned: {
				checks: plannedRest.length,
				notPassing: plannedRest.filter((c) => rankOf(c) < 2).length,
				notCurrent: plannedRest.filter((c) => rankOf(c) === 2).length,
			},
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
