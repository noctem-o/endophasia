// The acceptance ledger (docs/designs/develop-verification-plans.md §5): a pure function of an attempt's verification plan, its receipts,
// the working tree the reader chose, and when the attempt's send was authorised. It reads nothing, runs nothing and writes nothing.
//
// A planned check's receipts are found by exact argv, and only in the working tree being read: the identity `endoLatestChecksV0` uses (one
// argv, in one working tree, of one repository). A plan names an argv; it never widens what counts as the same check. The latest receipt
// at the current HEAD decides the check's state; a later receipt at another commit never hides it (as in the attention overview).

import {
	type EndoDevelopReceiptV0,
	type EndoReceiptCurrentV0,
	endoReceiptRelationV0,
} from "../../protocol/develop-receipts.ts";
import {
	type EndoAcceptanceLedgerV0,
	type EndoLedgerCheckV0,
	type EndoLedgerReceiptV0,
	type EndoPlannedCheckStateV0,
	type EndoVerificationPlanV0,
	endoCriterionStateV0,
} from "../../protocol/develop-verification.ts";
import { endoReceiptLaterV0 } from "./develop-attention.ts";

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

const latestOf = (receipts: readonly EndoDevelopReceiptV0[]): EndoDevelopReceiptV0 | null => {
	let latest: EndoDevelopReceiptV0 | null = null;
	for (const r of receipts) if (latest === null || endoReceiptLaterV0(r, latest)) latest = r;
	return latest;
};

const named = (r: EndoDevelopReceiptV0): EndoLedgerReceiptV0 => ({
	receiptId: r.id,
	commit: r.revision.commit,
	outcome: r.outcome,
	startedAtMs: r.startedAtMs,
	endedAtMs: r.endedAtMs,
});

/**
 * The ledger. `receipts` are this attempt's; `current` is the working tree the reader chose, observed now (null when it could not be).
 */
export function endoAcceptanceLedgerV0(input: {
	plan: EndoVerificationPlanV0;
	receipts: readonly EndoDevelopReceiptV0[];
	current: EndoReceiptCurrentV0 | null;
}): EndoAcceptanceLedgerV0 {
	const { plan, receipts, current } = input;
	const checks = plan.checks.map((check): EndoLedgerCheckV0 => {
		const all = receipts.filter((r) => sameArgv(r.check.argv, check.argv));
		const base = { name: check.name, runs: all.length };
		const none = { passed: 0, failed: 0, inconclusive: 0 };
		if (current === null) return { ...base, state: "unavailable", current: null, atHead: none, otherCommit: null };
		const related = all.map((r) => ({ r, relation: endoReceiptRelationV0(r, current) }));
		// In this working tree of this repository: everything else is a different check.
		const here = related.filter((x) => x.relation !== "other-worktree" && x.relation !== "other-repository");
		const headReceipts = here
			.filter((x) => x.relation === "at-head" || x.relation === "at-head-changed")
			.map((x) => x.r);
		const counts = { ...none };
		for (const r of headReceipts) counts[r.outcome] += 1;
		const atHead = latestOf(headReceipts);
		const other = latestOf(here.filter((x) => x.relation === "head-differs").map((x) => x.r));
		let state: EndoPlannedCheckStateV0;
		if (atHead !== null)
			state =
				endoReceiptRelationV0(atHead, current) !== "at-head"
					? "tree-changed"
					: counts[atHead.outcome] === headReceipts.length
						? atHead.outcome
						: "mixed";
		else if (here.length > 0) state = "stale";
		else if (all.length > 0) state = "elsewhere";
		else state = "not-run";
		return {
			...base,
			state,
			current: atHead === null ? null : named(atHead),
			atHead: counts,
			otherCommit: other === null ? null : named(other),
		};
	});
	const stateOf = new Map(checks.map((c) => [c.name, c.state]));
	return {
		checks,
		criteria: plan.criteria.map((c) => ({
			text: c.text,
			checks: [...c.checks],
			state: endoCriterionStateV0(c.checks.map((n) => stateOf.get(n) as EndoPlannedCheckStateV0)),
		})),
		unplanned: receipts.filter((r) => !plan.checks.some((c) => sameArgv(c.argv, r.check.argv))).length,
	};
}
