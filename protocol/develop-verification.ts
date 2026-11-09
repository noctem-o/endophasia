// DEVELOP verification plans and the acceptance ledger (docs/designs/develop-verification-plans.md).
//
// A plan is the operator's statement, made when they prepare an attempt, of which acceptance criteria will be checked by which command and
// which are left to their judgment. It lives inside the prepared attempt (`endo.develop-attempt.v1`), so it is written once, rendered into
// the brief the agent receives, and covered by the brief digest the operator approves.
//
// The ledger is DERIVED, never stored: a pure function of the plan, the attempt's receipts and the working tree being read
// (runtime/contracts/develop-verification.ts). It says what has been observed at the current HEAD for each planned check, and, for each
// criterion, a state that follows from its checks by one fixed rule (`endoCriterionStateV0`). It never says a criterion is met: that a
// command addresses a criterion is the plan's declaration, not an observation.

import type { EndoReceiptOutcomeV0 } from "./develop-receipts.ts";
import { checkEndoReceiptArgvV0 } from "./develop-receipts.ts";
import { checkEndoDevelopTextV0 } from "./develop-tasks.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_VERIFICATION_PLAN_LIMITS_V0 = Object.freeze({
	maxChecks: 8,
	maxCriteria: 12,
	/** The plan as JSON (UTF-8). Each argv is bounded by the receipt's own rule as well. */
	maxPlanBytes: 16 * 1024,
});

export const ENDO_CHECK_NAME_PATTERN_V0 = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A planned argument must be shown exactly wherever the plan is shown (the brief, the page, the terminal): no character the page would
 * replace, and no argument the page would cut. Nor may it hold the two characters the page's display-safe form puts in (U+FFFD for a
 * replaced character, U+2026 ending a cut argument), so a receipt's argv as the page shows it equals a planned argv only when it IS that
 * argv: the page can count a planned check's receipts itself, exactly. Two planned checks can never look alike.
 */
const SHOWN_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\ufffd\u2026]/;
export const ENDO_PLANNED_ARG_MAX_CHARS_V0 = 400;

export interface EndoPlannedCheckV0 {
	/** The operator's name for this command, unique in the plan. */
	name: string;
	/** The exact argv, as `endo attempt check -- <argv>` would take it. The check's identity: no two planned checks share one. */
	argv: string[];
	/** The operator's sentence of what this check shows. Their words; never interpreted. */
	shows: string;
}

export interface EndoPlannedCriterionV0 {
	/** One acceptance criterion, in the operator's words. */
	text: string;
	/** The planned checks the operator says address it; empty when it is left to their judgment. */
	checks: string[];
}

export interface EndoVerificationPlanV0 {
	checks: EndoPlannedCheckV0[];
	criteria: EndoPlannedCriterionV0[];
}

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const closed = (v: unknown, keys: readonly string[], what: string): Record<string, unknown> => {
	if (
		typeof v !== "object" ||
		v === null ||
		Array.isArray(v) ||
		(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(v, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const key of keys) if (!Object.hasOwn(v, key)) return bad(`${what} lacks ${key}`);
	return v as Record<string, unknown>;
};
const array = (v: unknown, max: number, what: string, min = 0): unknown[] =>
	Array.isArray(v) && v.length >= min && v.length <= max ? v : bad(`${what} is not a list of ${min} to ${max}`);

/** One line under the task protocol's `note` rule, already trimmed and not blank: what was written is what is read. */
function line(v: unknown, what: string): string {
	const checked = checkEndoDevelopTextV0("note", v);
	if (!checked.ok || checked.text !== v || checked.text === "")
		return bad(`${what} is not one non-blank line of at most 280`);
	return checked.text;
}

/**
 * A plan, checked. Throws `EndoInvalidRecordV0` for anything that breaks an invariant, so an invalid plan cannot be written or read:
 * unique, well-formed names; distinct argv, each one a receipt could hold; every check named by some criterion; every name a criterion
 * gives is a check of the plan, at most once; one-line texts; at most `maxPlanBytes` as JSON.
 */
export function validateEndoVerificationPlanV0(value: unknown): EndoVerificationPlanV0 {
	const r = closed(value, ["checks", "criteria"], "verification");
	const checks = array(r.checks, ENDO_VERIFICATION_PLAN_LIMITS_V0.maxChecks, "verification.checks").map((c, i) => {
		const x = closed(c, ["name", "argv", "shows"], `verification.checks[${i}]`);
		if (typeof x.name !== "string" || !ENDO_CHECK_NAME_PATTERN_V0.test(x.name))
			return bad(`verification.checks[${i}].name is not a check name`);
		if (!checkEndoReceiptArgvV0(x.argv))
			return bad(`verification.checks[${i}].argv is not an argv a receipt can hold`);
		if (x.argv.some((arg) => arg.length > ENDO_PLANNED_ARG_MAX_CHARS_V0 || SHOWN_UNSAFE.test(arg)))
			return bad(`verification.checks[${i}].argv has an argument that cannot be shown exactly`);
		return { name: x.name, argv: [...x.argv], shows: line(x.shows, `verification.checks[${i}].shows`) };
	});
	const names = new Set(checks.map((c) => c.name));
	if (names.size !== checks.length) return bad("verification.checks has two checks with one name");
	if (new Set(checks.map((c) => JSON.stringify(c.argv))).size !== checks.length)
		return bad("verification.checks has two checks with one argv");
	const criteria = array(r.criteria, ENDO_VERIFICATION_PLAN_LIMITS_V0.maxCriteria, "verification.criteria", 1).map(
		(c, i) => {
			const x = closed(c, ["text", "checks"], `verification.criteria[${i}]`);
			const named = array(
				x.checks,
				ENDO_VERIFICATION_PLAN_LIMITS_V0.maxChecks,
				`verification.criteria[${i}].checks`,
			);
			for (const name of named)
				if (typeof name !== "string" || !names.has(name))
					return bad(`verification.criteria[${i}].checks names no check of the plan`);
			if (new Set(named).size !== named.length) return bad(`verification.criteria[${i}].checks names a check twice`);
			return { text: line(x.text, `verification.criteria[${i}].text`), checks: named as string[] };
		},
	);
	for (const name of names)
		if (!criteria.some((c) => c.checks.includes(name)))
			return bad(`verification.checks: ${name} is named by no criterion`);
	const plan = { checks, criteria };
	if (new TextEncoder().encode(JSON.stringify(plan)).length > ENDO_VERIFICATION_PLAN_LIMITS_V0.maxPlanBytes)
		return bad("verification is larger than its bound");
	return plan;
}

// ---- the ledger ---------------------------------------------------------------------------------------------------------------------

/**
 * One planned check, related to the working tree being read. Only this attempt's receipts count (a receipt is linked to an attempt by the
 * operator who ran it):
 * - `passed` | `failed` | `inconclusive`: its latest receipt at the current HEAD, the tree clean now, and every receipt of it at this
 *   commit had that outcome;
 * - `mixed`: its receipts at the current HEAD (the tree clean now) did not all have one outcome: the latest is shown, the others counted;
 * - `tree-changed`: its latest receipt is at the current HEAD, but the tree has changes now (its outcome is shown, never counted);
 * - `stale`: it has receipts in this working tree only at other commits;
 * - `elsewhere`: it has receipts only in another working tree or repository (never compared);
 * - `not-run`: no receipt of this argv;
 * - `unavailable`: the working tree being read could not be observed.
 */
export type EndoPlannedCheckStateV0 =
	| EndoReceiptOutcomeV0
	| "mixed"
	| "tree-changed"
	| "stale"
	| "elsewhere"
	| "not-run"
	| "unavailable";

export const ENDO_PLANNED_CHECK_STATES_V0: readonly EndoPlannedCheckStateV0[] = [
	"passed",
	"failed",
	"inconclusive",
	"mixed",
	"tree-changed",
	"stale",
	"elsewhere",
	"not-run",
	"unavailable",
];

/** A criterion's state, from its checks' states by `endoCriterionStateV0`. None of them says the criterion is met. */
export type EndoCriterionStateV0 = "judgment" | "failed" | "inconclusive" | "passed" | "unavailable" | "not-shown";

export const ENDO_CRITERION_STATES_V0: readonly EndoCriterionStateV0[] = [
	"judgment",
	"failed",
	"inconclusive",
	"passed",
	"unavailable",
	"not-shown",
];

/**
 * The one rule a criterion's state follows, in this order: no check is the operator's judgment; any failure, then any inconclusive or mixed
 * result, decides it; every check passed at the current HEAD is `passed`; a working tree that could not be read is `unavailable`; anything else
 * (a check not run at this commit, stale, elsewhere, or its tree changed since) is `not-shown`. The page's gate re-derives it.
 */
export function endoCriterionStateV0(checks: readonly EndoPlannedCheckStateV0[]): EndoCriterionStateV0 {
	if (checks.length === 0) return "judgment";
	if (checks.includes("failed")) return "failed";
	if (checks.includes("inconclusive") || checks.includes("mixed")) return "inconclusive";
	if (checks.every((s) => s === "passed")) return "passed";
	if (checks.includes("unavailable")) return "unavailable";
	return "not-shown";
}

export const ENDO_CRITERION_LABELS_V0: Readonly<Record<EndoCriterionStateV0, string>> = Object.freeze({
	judgment: "Your judgment",
	failed: "A planned check failed at HEAD",
	inconclusive: "A planned check was inconclusive at HEAD",
	passed: "Planned checks passed at HEAD",
	unavailable: "Not compared",
	"not-shown": "Not shown at HEAD",
});

/** What each criterion state means, in one sentence, wherever it is explained. */
export const ENDO_CRITERION_TEXT_V0: Readonly<Record<EndoCriterionStateV0, string>> = Object.freeze({
	judgment:
		"No check addresses this criterion in the plan: it rests on your judgment, and nothing observed bears on it.",
	failed: "A check you planned for this criterion failed at the current HEAD.",
	inconclusive:
		"A check you planned for this criterion was inconclusive at the current HEAD, or its results at this commit disagree.",
	passed:
		"Every check you planned for this criterion passed at the current HEAD. That they address it is your plan's statement, not something observed.",
	unavailable: "The working tree could not be read, so no result is compared with it.",
	"not-shown":
		"A check you planned for this criterion has no result at the current HEAD of this clean working tree: not run here, run only at another commit or in another tree, or the tree has changed since.",
});

export const ENDO_PLANNED_CHECK_LABELS_V0: Readonly<Record<EndoPlannedCheckStateV0, string>> = Object.freeze({
	passed: "Passed at HEAD",
	failed: "Failed at HEAD",
	inconclusive: "Inconclusive at HEAD",
	mixed: "Results at HEAD disagree",
	"tree-changed": "At HEAD, but the tree has changed since",
	stale: "Not run at HEAD (only at other commits)",
	elsewhere: "Run only in another working tree",
	"not-run": "Not run",
	unavailable: "Not compared",
});

/** A receipt of a planned check, as the ledger names it. */
export interface EndoLedgerReceiptV0 {
	receiptId: string;
	commit: string;
	outcome: EndoReceiptOutcomeV0;
	startedAtMs: number;
	endedAtMs: number;
}

export interface EndoLedgerCheckV0 {
	name: string;
	state: EndoPlannedCheckStateV0;
	/** The latest receipt at the current HEAD of this working tree (`at-head` or `at-head-changed`); null when there is none. */
	current: EndoLedgerReceiptV0 | null;
	/** Every receipt of it at the current HEAD of this working tree, by outcome (the latest included). */
	atHead: Record<EndoReceiptOutcomeV0, number>;
	/**
	 * The latest receipt in this working tree at a commit other than the current HEAD; null when there is none or the tree could not be read.
	 * Not necessarily earlier in time, and not necessarily an ancestor: only another commit. A different outcome there is not explained:
	 * the change between the commits, flakiness, the inherited environment or ignored files could each account for it.
	 */
	otherCommit: EndoLedgerReceiptV0 | null;
	/** Every receipt of this argv for this attempt, in any tree. */
	runs: number;
}

export interface EndoLedgerCriterionV0 {
	text: string;
	checks: string[];
	state: EndoCriterionStateV0;
}

export interface EndoAcceptanceLedgerV0 {
	checks: EndoLedgerCheckV0[];
	criteria: EndoLedgerCriterionV0[];
	/** The attempt's receipts whose argv is no planned check's. */
	unplanned: number;
}
