// The acceptance ledger (docs/designs/develop-verification-plans.md §5): a pure function of an attempt's verification plan, its receipts,
// the working tree the reader chose, and when the attempt's send was authorised. It reads nothing, runs nothing and writes nothing.
//
// A planned check's receipts are found by exact argv, and only in the working tree being read: the identity `endoLatestChecksV0` uses (one
// argv, in one working tree, of one repository). A plan names an argv; it never widens what counts as the same check. The latest receipt
// at the current HEAD decides the check's state; a later receipt at another commit never hides it (as in the attention overview).
//
// A behavioural check (one whose plan entry declares `expect`) reads each receipt by `endoBehaviourOutcomeV0` instead of its exit status:
// the same states, counts and "latest" rule, over what the command did rather than whether it exited 0.

import {
	type EndoDevelopReceiptV0,
	type EndoReceiptCurrentV0,
	type EndoReceiptOutcomeV0,
	endoReceiptRelationV0,
} from "../../protocol/develop-receipts.ts";
import {
	type EndoAcceptanceLedgerV0,
	type EndoBehaviourObservedV0,
	type EndoExpectedBehaviourV0,
	type EndoLedgerCheckV0,
	type EndoLedgerReceiptV0,
	type EndoPlannedCheckStateV0,
	type EndoVerificationPlanV0,
	endoBehaviourOutcomeV0,
	endoCriterionStateV0,
} from "../../protocol/develop-verification.ts";
import { endoSha256HexV0 } from "../../storage/develop-receipts.ts";
import { endoReceiptLaterV0 } from "./develop-attention.ts";

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

const latestOf = (receipts: readonly EndoDevelopReceiptV0[]): EndoDevelopReceiptV0 | null => {
	let latest: EndoDevelopReceiptV0 | null = null;
	for (const r of receipts) if (latest === null || endoReceiptLaterV0(r, latest)) latest = r;
	return latest;
};

const named = (r: EndoDevelopReceiptV0, outcome: EndoReceiptOutcomeV0): EndoLedgerReceiptV0 => ({
	receiptId: r.id,
	commit: r.revision.commit,
	outcome,
	startedAtMs: r.startedAtMs,
	endedAtMs: r.endedAtMs,
});

/**
 * Kept output as the page shows it: each control, separator or direction character but a line break or tab becomes U+FFFD (the set the
 * page's argv form replaces). It is already within its bound, so nothing is cut.
 */
export const endoShownOutputV0 = (text: string): string =>
	text.replace(
		/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g,
		"\ufffd",
	);

/** A receipt's output digest as the behaviour rule reads it: null for a v0 receipt (not recorded) or output not read whole. */
export const endoReceiptStdoutShaV0 = (r: EndoDevelopReceiptV0): string | null => r.output.stdout?.sha256 ?? null;

/**
 * What a receipt observed of a behavioural check, as the page shows it. Kept text is made display-safe (each control, separator or
 * direction character but a line break or tab becomes U+FFFD), so what is shown can differ from the bytes in those characters only; the
 * comparison is the digest's.
 */
export function endoBehaviourObservedV0(r: EndoDevelopReceiptV0): EndoBehaviourObservedV0 {
	const out = r.output.stdout;
	const kept: EndoBehaviourObservedV0["kept"] =
		out === undefined
			? { state: "not-recorded" }
			: out.keep === "text"
				? {
						state: "text",
						text: endoShownOutputV0(out.text),
						truncated: out.truncated,
					}
				: { state: out.keep };
	return {
		receiptId: r.id,
		exitCode: r.execution.kind === "exited" ? r.execution.code : null,
		stdoutBytes: r.output.stdoutBytes,
		stdoutSha256: endoReceiptStdoutShaV0(r),
		kept,
	};
}

/** How a planned check reads a receipt: by its exit status, or for a behavioural check by what it did. */
function outcomeFor(expect: (EndoExpectedBehaviourV0 & { stdoutSha256: string }) | null) {
	return (r: EndoDevelopReceiptV0): EndoReceiptOutcomeV0 =>
		expect === null
			? r.outcome
			: endoBehaviourOutcomeV0(
					{ outcome: r.outcome, execution: r.execution, stdoutSha256: endoReceiptStdoutShaV0(r) },
					expect,
				);
}

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
		const expected =
			check.expect === undefined ? null : { ...check.expect, stdoutSha256: endoSha256HexV0(check.expect.stdout) };
		const outcome = outcomeFor(expected);
		const base = { name: check.name, runs: all.length };
		const none = { passed: 0, failed: 0, inconclusive: 0 };
		const behaviour = (latest: EndoDevelopReceiptV0 | null): EndoLedgerCheckV0["behaviour"] =>
			expected === null ? null : { expected, observed: latest === null ? null : endoBehaviourObservedV0(latest) };
		if (current === null)
			return {
				...base,
				state: "unavailable",
				current: null,
				atHead: none,
				otherCommit: null,
				behaviour: behaviour(null),
			};
		const related = all.map((r) => ({ r, relation: endoReceiptRelationV0(r, current) }));
		// In this working tree of this repository: everything else is a different check.
		const here = related.filter((x) => x.relation !== "other-worktree" && x.relation !== "other-repository");
		const headReceipts = here
			.filter((x) => x.relation === "at-head" || x.relation === "at-head-changed")
			.map((x) => x.r);
		const counts = { ...none };
		for (const r of headReceipts) counts[outcome(r)] += 1;
		const atHead = latestOf(headReceipts);
		const other = latestOf(here.filter((x) => x.relation === "head-differs").map((x) => x.r));
		let state: EndoPlannedCheckStateV0;
		if (atHead !== null)
			state =
				endoReceiptRelationV0(atHead, current) !== "at-head"
					? "tree-changed"
					: counts[outcome(atHead)] === headReceipts.length
						? outcome(atHead)
						: "mixed";
		else if (here.length > 0) state = "stale";
		else if (all.length > 0) state = "elsewhere";
		else state = "not-run";
		return {
			...base,
			state,
			current: atHead === null ? null : named(atHead, outcome(atHead)),
			atHead: counts,
			otherCommit: other === null ? null : named(other, outcome(other)),
			behaviour: behaviour(atHead),
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
